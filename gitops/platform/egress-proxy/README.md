# egress-proxy

Squid forward proxy that gives the opencode agent general web access
(`webfetch`, `curl`, docs) without opening the agent pod itself to the
internet. Only this pod has `0.0.0.0/0` egress, on 80/443, minus private
ranges; the agent reaches it via `HTTPS_PROXY`.

- **Audit log:** one line per request on stdout —
  `kubectl -n egress-proxy logs deploy/egress-proxy`. HTTPS shows as
  `CONNECT host:443` (no TLS interception, so no paths).
- **Blocked:** non-80/443 ports, CONNECT to anything but 443, and any
  destination in a private/loopback/link-local range (squid `private` ACL and
  the CiliumNetworkPolicy both enforce it).
- **Not proxied:** the agent's model providers, GitHub, npm and Exa stay on
  its direct FQDN allow-list (`NO_PROXY` in apps/opencode/deployment.yaml), so
  a proxy outage doesn't take the agent down.

Image: `cd image && docker build -t registry.nashes.uk/egress-proxy:6.12-1 . && docker push registry.nashes.uk/egress-proxy:6.12-1`
