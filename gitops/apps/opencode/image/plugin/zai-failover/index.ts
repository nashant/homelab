/**
 * zai-failover — automatically fail over to OpenRouter when the Z.AI coding
 * plan's WEEKLY usage window is (nearly) exhausted, with a session handover.
 *
 * Behaviour:
 *  - Polls GET https://api.z.ai/api/monitor/usage/quota/limit (undocumented,
 *    used by the Z.AI usage UI) every pollIntervalMs. The 5-hour window is
 *    deliberately ignored (it self-resets); only the weekly window triggers.
 *  - The Z.AI bearer token is captured automatically from outgoing model
 *    requests via the http.request hook (no secret stored in config). Falls
 *    back to $ZAI_API_KEY if set.
 *  - Also reacts to hard weekly-exhaustion 429s (Z.AI codes 1113/1310/1317…)
 *    via the retry hook and cancels the retry.
 *  - On trigger: interrupts recent sessions, switches the default model to
 *    OpenRouter, generates a HANDOVER-AUTO-<ts>.md + CONTINUATION-AUTO-<ts>.txt
 *    from the session transcript, and leaves a message in the session.
 *  - When the weekly window resets (usage falls back below switchBackBelow),
 *    the default model flips back to Z.AI automatically.
 */
import { Plugin } from "@opencode/plugin"
import { readFile, writeFile } from "node:fs/promises"

type Options = {
  enabled?: boolean
  zaiProvider?: string
  zaiModel?: string
  failoverProvider?: string
  failoverModel?: string
  quotaURL?: string
  /** weekly window used-% at which failover triggers */
  weeklyThreshold?: number
  /** weekly window used-% below which we switch back (hysteresis) */
  switchBackBelow?: number
  pollIntervalMs?: number
  apiKeyEnv?: string
  /** file holding the Z.AI key (e.g. a mounted Secret); wins over apiKeyEnv */
  apiKeyFile?: string
  autoSwitchBack?: boolean
}

const DEFAULTS = {
  zaiProvider: "zai-coding-plan",
  zaiModel: "glm-5.3",
  failoverProvider: "openrouter",
  failoverModel: "z-ai/glm-5.3-flash",
  quotaURL: "https://api.z.ai/api/monitor/usage/quota/limit",
  weeklyThreshold: 95,
  switchBackBelow: 90,
  pollIntervalMs: 120_000,
  apiKeyEnv: "ZAI_API_KEY",
  autoSwitchBack: true,
}

type WeeklyQuota = {
  pctUsed: number
  resetAt?: number // epoch ms
}

type Mode = "zai" | "switching" | "openrouter"

// 429 payloads that mean the weekly/monthly quota (or balance) is gone for real.
const WEEKLY_EXHAUSTED = /1317|1310|1318|1319|1320|1321|1113|weekly|past 7 days|7 day|seven.?day|monthly limit|insufficient balance/i
// 429 payloads that are only the 5-hour window — user said these can wait.
const FIVE_HOUR = /1316|1308|past 5 hours|5.?hour/i

function log(msg: string) {
  console.log(`[zai-failover] ${msg}`)
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function fmtReset(ms?: number): string {
  if (!ms) return "unknown"
  return new Date(ms).toLocaleString()
}

export default Plugin.define({
  id: "zai-failover",
  async setup(ctx) {
    const opt = { ...DEFAULTS, ...(ctx.options as Options | undefined) } as typeof DEFAULTS & Options
    if (opt.enabled === false) {
      log("disabled via options")
      return
    }

    const log_ = log
    const zai = opt.zaiProvider
    const failoverRef = { providerID: opt.failoverProvider, modelID: opt.failoverModel }

    // ---- state ------------------------------------------------------------
    let mode: Mode = "zai"
    let token: string | undefined = opt.apiKeyFile
      ? (await readFile(opt.apiKeyFile, "utf8").catch(() => "")).trim() || undefined
      : process.env[opt.apiKeyEnv ?? "ZAI_API_KEY"]
    let weekly: WeeklyQuota | undefined
    let lastPoll = 0
    let lastPollAttempt = 0
    let pollFailingSince = 0
    let inflight = false
    let cooldownUntil = 0
    let disposed = false
    const pollAbort = new AbortController()

    // restore mode across service restarts so we don't re-run the failover
    const saved = await ctx.storage.get<{ mode?: Mode }>("state")
    if (saved?.mode === "openrouter" || saved?.mode === "zai") {
      mode = saved.mode
      log(`restored mode=${mode} from storage`)
    }

    const persist = () => ctx.storage.set("state", { mode }).catch(() => {})

    // ---- quota polling ----------------------------------------------------
    async function poll(): Promise<void> {
      if (!token || disposed) return
      lastPollAttempt = Date.now()
      try {
        const res = await fetch(opt.quotaURL, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.status === 401 || res.status === 403) {
          token = undefined // stale; recapture from next model request
          log("quota endpoint rejected token — will recapture from next request")
          return
        }
        if (!res.ok) throw new Error(`quota endpoint HTTP ${res.status}`)
        const body: any = await res.json()
        const limits: any[] = body?.data?.limits ?? []
        // Weekly window = TOKENS_LIMIT/CREDIT_LIMIT with unit 6 (days).
        // unit 3 (hours) is the 5-hour window — ignored on purpose.
        const weeklyLimit = limits.find(
          (l) => (l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT") && l?.unit === 6,
        )
        if (!weeklyLimit) {
          log(`no weekly limit found in response (types: ${limits.map((l) => `${l?.type}/u${l?.unit}`).join(", ") || "none"})`)
          return
        }
        let pct = typeof weeklyLimit.percentage === "number" ? weeklyLimit.percentage : undefined
        if (pct === undefined && typeof weeklyLimit.usage === "number" && weeklyLimit.usage > 0) {
          pct = Math.round(((weeklyLimit.currentValue ?? 0) / weeklyLimit.usage) * 100)
        }
        if (typeof pct !== "number") return
        weekly = { pctUsed: pct, resetAt: weeklyLimit.nextResetTime }
        lastPoll = Date.now()
        if (pollFailingSince) {
          pollFailingSince = 0
          log("quota polling recovered")
        }
        log(`weekly window: ${pct}% used, resets ${fmtReset(weekly.resetAt)} (mode=${mode})`)
        evaluate()
      } catch (err: any) {
        if (!pollFailingSince) {
          pollFailingSince = Date.now()
          log(`quota poll failed: ${err?.message ?? err}`)
        }
      }
    }

    function evaluate() {
      if (!weekly || inflight || Date.now() < cooldownUntil) return
      if (mode === "zai" && weekly.pctUsed >= (opt.weeklyThreshold ?? 95)) {
        void failover(`weekly window at ${weekly.pctUsed}% (threshold ${opt.weeklyThreshold}%)`)
      } else if (mode === "openrouter" && opt.autoSwitchBack !== false && weekly.pctUsed < (opt.switchBackBelow ?? 90)) {
        void switchBack(`weekly window reset — now ${weekly.pctUsed}% used`)
      }
    }

    const timer = setInterval(() => {
      if (Date.now() - lastPollAttempt >= (opt.pollIntervalMs ?? 120_000)) void poll()
    }, 30_000)
    if (token) void poll()

    // ---- capture the Z.AI bearer token from live traffic -------------------
    await ctx.session.hook(
      "http.request",
      (event: any) => {
        const auth = event.request?.headers?.get?.("authorization") ?? event.request?.headers?.["Authorization"]
        if (typeof auth === "string" && auth.startsWith("Bearer ") && auth !== `Bearer ${token ?? ""}`) {
          token = auth.slice(7)
          if (!lastPoll) void poll() // bootstrap polling on first capture
        }
      },
      { providerID: zai },
    )

    // ---- hard 429 detection (weekly exhaustion only) -----------------------
    await ctx.session.hook(
      "retry",
      (event: any) => {
        const msg = String(event?.error?.message ?? "")
        if (event?.error?.status === 429 && WEEKLY_EXHAUSTED.test(msg)) {
          log(`weekly-exhaustion 429 observed: ${msg.slice(0, 300)}`)
          event.decision = { retry: false }
          void failover(`Z.AI refused the request — weekly quota exhausted (${msg.slice(0, 160)})`, event.sessionID)
        } else if (event?.error?.status === 429 && FIVE_HOUR.test(msg)) {
          log_(`5-hour window 429 observed, leaving default retry behaviour: ${msg.slice(0, 160)}`)
        }
      },
      { providerID: zai },
    )

    // ---- session helpers ---------------------------------------------------
    async function recentSessions(): Promise<{ id: string; directory?: string; title?: string }[]> {
      try {
        const page: any = await ctx.session.list({ directory: ctx.location.directory, limit: 20 })
        const items: any[] = page?.items ?? page?.sessions ?? []
        const cutoff = Date.now() - 30 * 60_000
        return items
          .filter((s) => {
            const updated = s?.time?.updated ?? s?.updated ?? 0
            return !s?.parentID && updated >= cutoff
          })
          .sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))
          .map((s) => ({ id: s.id, directory: s.directory, title: s.title }))
      } catch (err: any) {
        log(`session list failed: ${err?.message ?? err}`)
        return []
      }
    }

    function transcriptText(messages: any[]): string {
      const lines: string[] = []
      for (const m of messages) {
        const role = m?.info?.role ?? m?.role ?? "?"
        const parts: any[] = m?.parts ?? []
        const bits: string[] = []
        for (const p of parts) {
          if (p?.type === "text" && typeof p.text === "string") bits.push(p.text)
          else if (p?.type === "tool") bits.push(`[used tool ${p.name ?? p.tool ?? ""}]`)
          else if (p?.type === "step-start") continue
        }
        const text = bits.join("\n").trim()
        if (text) lines.push(`${String(role).toUpperCase()}: ${text}`)
      }
      let out = lines.slice(-200).join("\n\n")
      if (out.length > 110_000) out = `…(older transcript elided)…\n\n${out.slice(-110_000)}`
      return out
    }

    async function generateHandover(transcript: string): Promise<string> {
      const prompt = `You are writing a handover document for an AI coding session that is being stopped mid-task because its model provider quota ran out. A fresh session (possibly on a different provider) will continue from this document alone.

Use ONLY the transcript below. Write markdown in this shape:

# Handover — <short descriptive title> (<date>)

## Goal
What this session is working towards and why.

## State
What is done and verified — file paths, commands, commits, figures. Be specific.

## In flight
Exactly where work stopped, what was partially done, and the next concrete actions in order.

## Gotchas
User rules, environment notes, traps, things not to redo or re-raise.

Rules: be factual and specific; cite file paths and command output from the transcript; do not invent; if something is unverified say so; max ~150 lines.

TRANSCRIPT:
${transcript}`

      // Prefer Z.AI (still has headroom on threshold trigger); on any failure
      // fall through to OpenRouter.
      const attempts = [
        { providerID: zai, modelID: opt.zaiModel },
        failoverRef,
      ]
      let lastErr: any
      for (const model of attempts) {
        try {
          const out = await ctx.generate.text({ model, prompt })
          if (out?.text?.trim()) return out.text.trim()
        } catch (err: any) {
          lastErr = err
          log(`handover generation via ${model.providerID} failed: ${err?.message ?? err}`)
        }
      }
      throw lastErr ?? new Error("handover generation produced nothing")
    }

    function extractInFlight(handover: string): string {
      const m = handover.match(/^##\s*In flight\s*$/im)
      if (!m) return ""
      const rest = handover.slice(m.index! + m[0].length)
      const next = rest.match(/^##\s/m)
      const section = (next ? rest.slice(0, next.index) : rest).trim()
      return section.split("\n").slice(0, 20).join("\n")
    }

    // ---- failover ----------------------------------------------------------
    async function failover(trigger: string, knownSessionID?: string): Promise<void> {
      if (inflight || mode !== "zai") return
      inflight = true
      mode = "switching"
      log(`FAILOVER TRIGGERED — ${trigger}`)
      try {
        // 1. stop burning Z.AI: interrupt recent sessions
        const sessions = await recentSessions()
        const targets = knownSessionID
          ? [{ id: knownSessionID, directory: ctx.location.directory }, ...sessions.filter((s) => s.id !== knownSessionID)]
          : sessions
        for (const s of targets) {
          await ctx.session.interrupt({ sessionID: s.id, continue: false }).catch(() => {})
        }

        // 2. flip the default model to OpenRouter
        await ctx.model.transform((editor: any) => {
          editor.default.set(failoverRef.providerID, failoverRef.modelID)
        })
        log(`default model switched to ${failoverRef.providerID}/${failoverRef.modelID}`)

        // 3. handover docs (best effort, never blocks the switch)
        const notes: string[] = []
        let handoverPath: string | undefined
        let continuationPath: string | undefined
        let continuation: string | undefined
        try {
          const models = await ctx.model.list()
          if (!models.some((m: any) => m.providerID === failoverRef.providerID)) {
            log(`WARNING: no ${failoverRef.providerID} models visible — is the OpenRouter API key configured?`)
            notes.push(
              `⚠️ No OpenRouter models were visible in the registry — run \`opencode auth login\` and pick OpenRouter (or set OPENROUTER_API_KEY) before your next session.`,
            )
          }
        } catch {}

        for (const s of targets.slice(0, 2)) {
          try {
            const messages = await ctx.session.context({ sessionID: s.id })
            const transcript = transcriptText(messages as any[])
            if (!transcript) continue
            const dir = (s as any).directory ?? ctx.location.directory
            const ts = stamp()
            handoverPath = `${dir}/HANDOVER-AUTO-${ts}.md`
            continuationPath = `${dir}/CONTINUATION-AUTO-${ts}.txt`
            let handover: string
            try {
              handover = await generateHandover(transcript)
            } catch {
              // last resort: raw transcript tail so the user still has context
              log("LLM handover failed — writing raw transcript tail instead")
              handover = `# Handover (raw fallback) — ${ts}\n\nLLM summary failed; raw transcript tail follows.\n\n\`\`\`\n${transcript.slice(-40_000)}\n\`\`\`\n`
            }
            const inFlight = extractInFlight(handover)
            const reset = fmtReset(weekly?.resetAt)
            const continuationText = `Read HANDOVER-AUTO-${ts}.md in ${dir} first — full context. We stopped because the Z.AI weekly quota hit ${weekly?.pctUsed ?? "?"}% (resets ${reset}); you are now on OpenRouter ${opt.failoverModel}. Resume from the "In flight" section of the handover${inFlight ? ", which begins:\n\n" + inFlight : ""}. Verify live file/git state before trusting the handover — things may have moved since it was written.`
            continuation = continuationText
            await writeFile(handoverPath, `${handover}\n\n---\n_Auto-generated by zai-failover at ${new Date().toISOString()} — trigger: ${trigger}_\n`, "utf8")
            await writeFile(continuationPath, continuationText, "utf8")
            log(`handover written: ${handoverPath}`)
            break // one handover is enough even if several sessions were live
          } catch (err: any) {
            log(`handover for session ${s.id} failed: ${err?.message ?? err}`)
          }
        }

        // 4. tell the user, in the session, where things are
        const message = [
          `⚠️ **zai-failover: switched to OpenRouter**`,
          ``,
          `Reason: ${trigger}. Weekly window: ${weekly?.pctUsed ?? "?"}% used, resets ${fmtReset(weekly?.resetAt)} (auto-switch-back will happen after the reset).`,
          ...(handoverPath ? [``, `Handover: \`${handoverPath}\``] : [``, `No active session transcript was available, so no handover doc was written.`]),
          ...notes,
          ``,
          `**Please \`/clear\` and start a fresh session**, then paste this continuation prompt:`,
          ...(continuation ? ["", "```", continuation, "```"] : []),
        ].join("\n")
        for (const s of targets) {
          await ctx.session.synthetic({ sessionID: s.id, text: message }).catch(() => {})
        }

        mode = "openrouter"
        cooldownUntil = Date.now() + 10 * 60_000
        await persist()
      } catch (err: any) {
        log(`FAILOVER FAILED: ${err?.message ?? err} — reverting to zai mode`)
        mode = "zai"
      } finally {
        inflight = false
      }
    }

    // ---- switch back -------------------------------------------------------
    async function switchBack(reason: string): Promise<void> {
      if (mode !== "openrouter" || inflight) return
      inflight = true
      try {
        await ctx.model.transform((editor: any) => {
          editor.default.set(zai, opt.zaiModel)
        })
        mode = "zai"
        cooldownUntil = Date.now() + 10 * 60_000
        await persist()
        log(`SWITCHED BACK to ${zai}/${opt.zaiModel} — ${reason}`)
        for (const s of await recentSessions()) {
          await ctx.session
            .synthetic({ sessionID: s.id, text: `✅ **zai-failover**: Z.AI weekly quota has reset (${reason}). Default model switched back to ${zai}/${opt.zaiModel}. No action needed.` })
            .catch(() => {})
        }
      } catch (err: any) {
        log(`switch-back failed: ${err?.message ?? err}`)
      } finally {
        inflight = false
      }
    }

    // ---- status / manual control tool ---------------------------------------
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "zai_failover_status",
        description:
          "Check or control the zai-failover plugin: Z.AI weekly quota usage, failover mode, force a poll, or trigger/undo failover manually.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "poll", "failover", "switchback"],
              description: "status (default), poll = force a quota refresh now, failover/switchback = run the switch manually",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: { action?: string }) => {
          const action = input.action ?? "status"
          if (action === "poll") {
            lastPollAttempt = 0
            await poll()
          } else if (action === "failover") {
            void failover("manual trigger via zai_failover_status tool")
          } else if (action === "switchback") {
            void switchBack("manual trigger via zai_failover_status tool")
          }
          return {
            content: JSON.stringify(
              {
                mode,
                failover: `${opt.failoverProvider}/${opt.failoverModel}`,
                weekly,
                resetAtHuman: fmtReset(weekly?.resetAt),
                threshold: opt.weeklyThreshold,
                switchBackBelow: opt.switchBackBelow,
                tokenAvailable: Boolean(token),
                lastPoll: lastPoll ? new Date(lastPoll).toISOString() : null,
              },
              null,
              2,
            ),
          }
        },
      })
    })

    log(`loaded (zai=${zai}/${opt.zaiModel} → failover=${opt.failoverProvider}/${opt.failoverModel}, weekly trigger ${opt.weeklyThreshold}%, switch back < ${opt.switchBackBelow}%, poll ${opt.pollIntervalMs}ms, token=${token ? "available" : "will capture from first request"})`)

    return () => {
      disposed = true
      clearInterval(timer)
      pollAbort.abort()
      log("unloaded")
    }
  },
})
