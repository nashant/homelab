# homelab

GitOps manifests for a three-node K3s home cluster. Flux CD reconciles this repository and applies
the manifests to the cluster.

## Layout

All manifests are under `gitops/`:

- `gitops/apps/` — applications (home automation, media, finance, AI).
- `gitops/platform/` — platform components (networking, storage, observability, secrets, ingress).
- `gitops/components/` — shared kustomize components that the apps and platform reference.
- `gitops/charts/` — vendored Helm charts (for example the Gateway API and Traefik CRDs).

Flux reads only the `gitops/` tree. Each directory holds a `kustomization.yaml` that lists its
resources. HelmReleases embed their values inline; no separate values files exist.

## Secrets

This repository holds no secret values. Applications read their secrets at runtime through the
External Secrets Operator, which pulls from AWS SSM Parameter Store. The manifests reference the
parameter names only.

The AWS account ID, role ARNs, hosted-zone IDs and similar values in these manifests are
identifiers, not credentials. They grant no access on their own.
