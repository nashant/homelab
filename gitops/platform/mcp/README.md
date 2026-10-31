# mcp

MCP servers for the opencode agent, one Deployment per server, each holding its
own credential so the agent never sees it. opencode reaches them at
`http://<server>.mcp.svc:8080/mcp` (apps/opencode: `opencode.json` + the
`mcp` egress rule in netpolicy.yaml).

- **Agent boundary:** `mcp` is not an opencode edit namespace, so the agent
  can't mount these Secrets, exec in, or change the policies.
- **Per-server isolation:** each server's CiliumNetworkPolicy allows only its
  own upstream (e.g. OPNsense: `172.16.0.1:443`); pods don't mount SA tokens.
- **No auth on the MCP endpoint:** the namespace policy admitting only the
  opencode pod is the gate. Anything that can reach the port acts with the
  server's credential.

## opnsense

[opnsense-mcp-server](https://github.com/lucamarien/opnsense-mcp-server)
(PyPI), served over streamable HTTP by `opnsense/image/serve.py` (upstream
only ships stdio). Writes enabled. OPNsense user `opencode-mcp` in group
`mcp-agent`: all privileges except user/auth management, firmware,
backup/restore/config history, reboot/halt/factory reset, cron, Monit, captive
portal, packet capture, certificates/CAs and VPN key material; API logins only
from 172.30.0.0/16 (pod CIDR). Key: SSM `/k8s/opnsense-mcp/api-{key,secret}`.

Firewall writes get OPNsense's 60 s savepoint auto-revert only below 26.7
(`opn_mcp_info` → `savepoint_support`); `opn_reconfigure_*` never do. Write
tools are `ask` in opencode's permission config.

TLS verification is off: OPNsense serves a self-signed cert for
`opnsense.home` and the package has no CA option.

Image: `cd opnsense/image && docker build -t registry.nashes.uk/mcp-opnsense:0.4.1-3 . && docker push registry.nashes.uk/mcp-opnsense:0.4.1-3`
