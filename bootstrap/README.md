# Bootstrap

These targets build the cluster from bare nodes. Run them from this directory, in this order:

```bash
make install_amd64-1.home install_amd64-2.home install_amd64-3.home
make install_cilium
make install_flux_operator
```

- The nodes stay NotReady until Cilium runs. K3s starts without flannel and kube-proxy.
- `install_flux_operator` installs the Flux Operator and applies the FluxInstance `flux`. The operator installs the Flux controllers. It also creates the sync to `gitops/clusters/prod`.
- Flux then applies the `platform` and `apps` Kustomizations, and these install everything else.
- Each target reads the chart version and values from the HelmRelease in `gitops/`. No separate values files exist.

After the bootstrap, Flux manages Cilium and the Flux Operator through their HelmReleases. Upgrade them in git. Do not run these targets again.

## Known gap

On an empty cluster, the `platform` Kustomization fails until the operators' CRDs exist. `platform` is one Flux Kustomization, and Flux applies it as a single unit. Its custom resources fail until their CRDs exist, for example the cert-manager issuers, the Crossplane objects and the ServiceMonitors. A fresh cluster converges only after the platform is split into layers: the operators first, then their configuration.
