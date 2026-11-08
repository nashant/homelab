# opnsense

cert-manager issues `opnsense.nashes.uk` (`letsencrypt-prod`, Route53 DNS-01), and the daily
`opnsense-cert-sync` CronJob pushes it to the OPNsense web GUI through the Trust API
(`sync.sh`). The call sequence follows [0xabu/opnsense-cert](https://github.com/0xabu/opnsense-cert),
but that script drops the last cert in the bundle as a root. cert-manager's `tls.crt` is the
leaf plus its intermediate, so the script would drop the intermediate.

Each run:

1. Exits with "unchanged" if the GUI already serves the leaf in `tls.crt` (SHA-256 fingerprint).
2. Imports any missing intermediate as a CA (`trust/ca/add`).
3. Replaces the cert whose CN is `opnsense.nashes.uk` in place (`trust/cert/set/<uuid>`). The
   uuid and refid stay the same, so the GUI keeps its selection. If no such cert exists, it
   adds one (`trust/cert/add`) and stops there.
4. Restarts the web GUI (`core/service/restart/webgui`). The job then fails if the GUI doesn't
   serve the new cert 15 s later.

The API can't select the GUI certificate. That one step stays manual.

## One-time setup

1. **DNS.** Under Services > Unbound DNS > Overrides, add the host override `opnsense`, domain
   `nashes.uk`, address `172.16.0.1`. Check it with Interfaces > Diagnostics > DNS Lookup.
   - The record lives on the firewall, not in BIND. external-dns-bind runs `policy: sync`, so it
     would prune a hand-made record there.
   - Resolving the firewall's own name shouldn't depend on the cluster.
2. **API user.** Create user `cert-sync` in its own group.
   - Privileges: System: Trust: Authorities, System: Trust: Certificates, Status: Services.
   - API logins only from `172.30.0.0/16` (the pod CIDR).
   - Store the key and secret in SSM (eu-west-2) as `/k8s/opnsense-cert/api-key` and
     `/k8s/opnsense-cert/api-secret`.
3. **Bootstrap run.** Once `kubectl -n opnsense get certificate opnsense` is Ready, run the job
   once with TLS verification off. The GUI still serves its self-signed cert at this point.

   ```sh
   kubectl -n opnsense create job --from=cronjob/opnsense-cert-sync bootstrap --dry-run=client -o yaml \
     | yq '(.spec.template.spec.containers[0].env[] | select(.name == "INSECURE").value) = "1"' \
     | kubectl apply -f -
   kubectl -n opnsense logs -f job/bootstrap
   ```

   It imports the intermediate and adds the cert.
4. **Select the cert.** Under System > Settings > Administration:
   - Set SSL Certificate to `opnsense.nashes.uk`.
   - Add `opnsense.nashes.uk` to Alternate Hostnames, so the GUI's DNS-rebind/referer check
     accepts the name.
5. **Exporter.** `monitoring/opnsense` trusted only the old self-signed cert. Move it to
   `opnsense.nashes.uk` with the system CAs.

Use the same `INSECURE=1` run to recover if the GUI cert ever expires.
