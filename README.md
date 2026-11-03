# homelab

GitOps manifests for a three-node K3s home cluster. Flux CD reconciles this repository and applies
the manifests to the cluster.

## Layout

All manifests are under `gitops/`:

- `gitops/apps/` — applications (home automation, media, finance, AI).
- `gitops/platform/` — platform components (networking, storage, observability, secrets, ingress).
- `gitops/components/` — shared kustomize components that the apps and platform reference.
- `gitops/charts/` — vendored Helm charts (for example the Gateway API and Traefik CRDs).
- `gitops/clusters/prod/` — the Flux sync root. It holds the Flux Kustomizations `platform` and `apps`.
- `bootstrap/` — the Makefile that builds the cluster from bare nodes (see `bootstrap/README.md`).

The Flux Operator runs Flux. FluxInstance `flux` (`gitops/platform/flux/fluxinstance.yaml`) syncs
`gitops/clusters/prod`. Kustomization `platform` applies `gitops/platform`, and `apps` applies
`gitops/apps` after `platform` is ready. Each directory holds a `kustomization.yaml` that lists its
resources. HelmReleases embed their values inline; no separate values files exist.

## Secrets

This repository holds no secret values. Applications read their secrets at runtime through the
External Secrets Operator, which pulls from AWS SSM Parameter Store. The manifests reference the
parameter names only.

The AWS account ID, role ARNs, hosted-zone IDs and similar values in these manifests are
identifiers, not credentials. They grant no access on their own.
