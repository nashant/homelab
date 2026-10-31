# octo-sts

Self-hosted [octo-sts](https://github.com/octo-sts/app): trades a Kubernetes
ServiceAccount token for a GitHub App installation token (1 hour, scoped to
one repo and the permissions in that repo's trust policy). Replaces the
long-lived PAT the opencode agent used to hold.

- The App's private key exists only in AWS KMS. octo-sts signs App JWTs with
  `kms:Sign` via IRSA; the PEM is deleted after import.
- Callers present a projected SA token for audience `octo-sts.octo-sts.svc`.
  octo-sts validates it against this cluster's public issuer only
  (`OCTOSTS_ALLOWED_ISSUERS`).
- Each repo grants access with `.github/chainguard/<identity>.sts.yaml`, read
  from its **default branch**.
- No webhook component and no inbound from GitHub: token exchange needs none.

## Setup

1. **GitHub App** — github.com → Settings → Developer settings → GitHub Apps →
   New (`nashant-octo-sts`, ID 5464949). Webhook: untick *Active*. Repository
   permissions: Actions R, Checks R, Commit statuses R, Contents RW, Issues RW,
   Pull requests RW, Workflows RW, Metadata R; nothing else (never
   Administration or Secrets). "Only on this account", installed on **All
   repositories**: a repo's trust policy is the per-repo gate. After a
   permission change, accept it on the installation or exchanges fail with
   GitHub 422.
2. **KMS** — RSA_2048 SIGN_VERIFY key with `Origin EXTERNAL`, alias
   `alias/octo-sts-github-app`; import the PEM as PKCS#8 DER wrapped with
   `RSA_AES_KEY_WRAP_SHA_256`
   ([AWS docs](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-encrypt-key-material.html)),
   then shred the PEM. Rotating = new App key → reimport.
3. **Per repo** — trust policy plus branch protection (below).

## Trust policy

`.github/chainguard/opencode.sts.yaml` in each repo the agent may write to:

```yaml
issuer: https://23oak-k8s-oidc.s3.eu-west-2.amazonaws.com
subject: system:serviceaccount:opencode:opencode
audience: octo-sts.octo-sts.svc
permissions:
  contents: write
  pull_requests: write
```

Owner-wide **read-only** access (`gh repo list`, cloning repos without their
own policy) is `scope=nashant&identity=opencode-read`, from
`nashant/.github/.github/chainguard/opencode-read.sts.yaml`; the same repo's
`trusted-token-issuers.yaml` admits only this cluster's issuer. No policy
grants write to `nashant/.github`.

The agent can push to the repo, so it can edit this file too. Protect the
default branch (PR + review required, App not on the bypass list) and add a
CODEOWNERS entry for `.github/chainguard/`, or it can widen its own grant up
to the App's permissions.

## Calling it

```
curl -H "Authorization: Bearer $(cat <projected token>)" \
  "http://octo-sts.octo-sts.svc/sts/exchange?scope=<owner>/<repo>&identity=opencode"
# → {"token": "ghs_..."}
```
