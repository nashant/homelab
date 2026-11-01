# opencode (in-cluster agent)

One pod, two containers sharing the PVC, SA and sandbox: `web` runs the one
opencode server (`opencode serve --service`; see "One server"), `herdr`
runs an unprivileged sshd that `herdr --remote` attaches through. The pod is
the quarantine boundary:

- **gVisor (runsc)** runtime class — the agent's shell/code executes inside a
  userspace kernel; node kernel and host filesystem are unreachable.
- **PSA restricted** namespace — non-root (uid 1000), read-only rootfs, all
  capabilities dropped, no hostPath, no SA-token-less... (SA token *is* mounted
  deliberately: see RBAC).
- **RBAC** — `opencode:view` read-only cluster-wide (no Secrets, no
  exec/proxy); `opencode:edit` only in opencode, automation, media, dev,
  finance, ai; `admission-policy.yaml` guards those writes. See "RBAC" below.
- **Cilium allow-list egress** — DNS, the k8s API VIP, model/git/npm FQDNs,
  Exa's MCP (`mcp.exa.ai`, web search + fetch), the logged squid forward
  proxy for any other web access (`platform/egress-proxy`, via
  `HTTPS_PROXY` in proxy-env.yaml),
  octo-sts, everything in `automation` + `media` namespaces, HA 8123 and
  esphome 6052 (hostNetwork). Everything else — LAN, nodes, etcd, kubelet,
  VPN, arbitrary internet — implicitly denied. Ingress: private-traefik only
  (LAN/VPN): `opencode.nashes.uk` (HTTP) and `herdr.nashes.uk` (SSH in TLS).

## First deployment (run order)

1. **Nodes** — install runsc, one node at a time (see header of
   node-prep-runsc.sh for the rolling loop).
2. **Image** — build & push:
   ```
   cd clusters/prod/apps/opencode/image
   docker build -t registry.nashes.uk/opencode:2.1.2-7 .
   docker push registry.nashes.uk/opencode:2.1.2-7
   ```
3. **Credentials** — SSM SecureStrings under `/k8s/opencode/`, synced by
   `opencode-es.yaml` into Secret `opencode` and mounted as files under
   `/opt/secrets` (no env vars, so the agent's subprocesses don't inherit
   them). Load each without echoing it:
   ```
   put() { aws --profile home-cluster --region eu-west-2 ssm put-parameter \
     --type SecureString --overwrite --name "/k8s/opencode/$1" --value "file://$2"; }
   # zai-api-key, openrouter-api-key: provider API keys ({file:} refs in opencode.json)
   # server-password: openssl rand -base64 24
   # hass-token: HA UI → profile → Security → Long-Lived Access Tokens
   ```
   GitHub has no stored credential: git and `~/bin/github-token <owner>/<repo>`
   get 1-hour per-repo tokens from octo-sts (`platform/octo-sts/README.md`),
   so each repo needs the App installed and an `opencode.sts.yaml` policy.
   In service mode, opencode reads the server password only from
   `~/.config/opencode/service.json`. The `web` container copies it there
   from the mounted file at each start. No credential is in opencode's
   environment.
4. **Apply** — `kubectl apply -k clusters/prod/apps/opencode` (or commit and
   let flux reconcile; this repo is the source of truth).
5. **Clone repos** — `kubectl -n opencode exec -it deploy/opencode -- git clone
   https://github.com/<owner>/<repo>.git /home/opencode/repos/<repo>`.

## Connect

**herdr (laptop).** SSH rides private-traefik's 443: Traefik terminates TLS
(wildcard cert), routes on SNI `herdr.nashes.uk` (`tcproute.yaml`) and
forwards plain TCP to sshd :2222. Key-only, user `opencode`; keys are
`authorized-keys.yaml`. `~/.ssh/config`:
```
Host herdr.nashes.uk
  User opencode
  ProxyCommand openssl s_client -quiet -verify_return_error -connect %h:443 -servername %h
```
then `herdr --remote herdr.nashes.uk` (or `herdr machine add`). Inside, run
plain `opencode`. It attaches to the `web` server (see "One server").
`herdr.nashes.uk` is published by external-dns from the Service annotations.

**Phone.** In a herdr pane, run
`opencode pair --url https://opencode.nashes.uk` and open the link or scan
the QR code. The pairing code is valid only on the server that issued it.

**Web / phone.**
```
opencode --server https://opencode.nashes.uk   # LAN/VPN; private-traefik
```
HTTP basic auth: user `opencode`, password SSM `/k8s/opencode/server-password`.
The 2.x client has no `attach`; it reads the password from `OPENCODE_PASSWORD`
(falling back to `OPENCODE_SERVER_PASSWORD`). On the laptop, `~/.local/bin/oc`
fetches it from SSM per run (SSO login if expired) and passes the rest through:
`oc` opens the TUI, `oc api GET /api/session` etc. The password stays on:
behind this page are the agent's RBAC, HA token and model keys.
The API is under `/api/` (401 without it); other paths serve the web UI shell.
Off-LAN fallback: `kubectl -n opencode port-forward deploy/opencode 8080:8080`.

## One server

All clients use the server in the `web` container: the web UI, the phone,
`oc` on the laptop and `opencode` in herdr panes. Only one server must use
the SQLite database. From 2026-10-25 to 2026-10-31, each pod ran two: `web`
and one that a herdr pane started (the `0.0.0.0` probe failure below).

How it works (opencode 2.1.2):

- `opencode serve --service` writes its URL, PID and password to
  `~/.local/state/opencode/service.json`.
- A bare `opencode`, `opencode pair` or `opencode api` reads that file.
  It probes `<url>/api/info`. If the probe fails, the client starts a new
  `serve --service` in its own container.
- The registered URL is `http://0.0.0.0:8080`. `0.0.0.0` must be in
  `NO_PROXY` (`proxy-env.yaml`). If it is not, squid returns 403 to the
  probe, and every pane starts its own server.
- Service mode ignores `--hostname`, `--port` and `OPENCODE_SERVER_PASSWORD`
  when its config file has values. It reads them from
  `~/.config/opencode/service.json`. The `web` container pins hostname
  `0.0.0.0`, port `8080` and the SSM password there at each start.

- A client that gets no answer from the registered server waits 5 s, then
  starts its own `serve --service` in its own container.
- A client that gets three probe timeouts sends SIGTERM, then SIGKILL, to
  the registered pid. `opencode service stop`, `restart` and `set` do the
  same. The pod sets `shareProcessNamespace: true` so that this pid is the
  server in both containers. Without it, the pid is 1, which is sshd in
  the `herdr` container.

The `web` container runs `serve --service` in a loop and never exits by
itself. After a crash, it starts the server again in 1 s, before a pane
can start one. If a pane starts the server first, it uses the same address
and password, so all clients still reach it. `serve` in `web` then returns
at once, and the loop tries again every 10 s until that server stops. The
pod stays Ready, so the ingress continues to work. Port 8080 accepts only
one server. To move the server back to `web`, restart the pod.

Check: `opencode service status` in either container must print
`http://0.0.0.0:8080`, not `stopped`. `ps -o pid,ppid,args` must show one
`opencode serve --service`. Its parent must be the `web` loop
(`/bin/sh -c set -eu ...`).

## Honest capability & residual-risk notes

- The agent CAN create/patch/delete workloads, PVCs, ConfigMaps, Services and
  Ingresses in the six edit namespaces, exec into any pod there, and read
  everything cluster-wide except Secrets.
- The agent CANNOT write anything elsewhere, read Secrets, mint SA tokens,
  write RBAC/webhooks/CRDs/NetworkPolicies/Cilium policies/Longhorn/Flux/
  Crossplane/external-secrets objects, or escape to node kernels (gVisor).
- Adding a platform operator = append its apiGroup to `opencode:view` in
  rbac.yaml, or the agent can't see it. Add it to `opencode:edit` only if its
  CRs can't run pods or commands with the operator's privileges.
- Nothing in the edit namespaces is privileged or holds host D-Bus/NET_ADMIN
  (HA, esphome and ep-configurator are hostNetwork with default caps only),
  so exec into any of them is allowed. Adding a privileged or host-socket
  workload there = add an exec/attach/portforward CONNECT policy that blocks
  it by pod-name prefix (a CONNECT request carries only the pod name).
- Longhorn volume snapshots of /home/opencode = whole-environment checkpoints.
- zai-failover plugin is baked in (weekly quota → openrouter/glm-5.3-flash
  failover with handover, auto switch-back).

## RBAC

Until 2026-10-24 the agent had "admin minus Secrets" cluster-wide, which was
not a boundary:
- RBAC on `secrets` isn't checked when a pod *mounts* a Secret, so pod create
  in a namespace = read of all its Secrets.
- Cluster-wide pod create meant running pods as cluster-admin-bound SAs
  (`kube-system/helm-gateway-api-crd`, `longhorn-system/longhorn-support-bundle`),
  IRSA SAs (`crossplane-system` → `crossplane-iam`), or privileged/hostPath
  pods in any namespace without a PSA label (all but two).
- Flux Kustomizations are applied by the cluster-admin kustomize-controller;
  Crossplane packages, external-secrets stores and Cilium policies were
  further routes around every exclusion.

`admission-policy.yaml` holds ValidatingAdmissionPolicies that match only the
opencode SA's requests (the agent can't edit admission objects):
- `opencode-workloads` — pods and every workload's pod template: no host
  namespaces, hostPath, privileged/unmasked/seccomp-unconfined containers,
  non-baseline capabilities or hostPorts; pods in `opencode` must use runsc.
  Consequence: the agent can't edit HA, esphome, frigate (hostPaths) or
  ep-configurator (their templates fail it).
- `opencode-exposure` — no public-traefik ingresses, UPnP Service
  annotations, externalIPs, or IRSA role-arn annotations on ServiceAccounts.

Residual risk: Secrets and PVC data in the six edit namespaces are reachable
by mounting them in a pod, and pods there are outside the opencode egress
allow-list. Keep platform credentials (e.g. a GitHub App PEM) out of them.
