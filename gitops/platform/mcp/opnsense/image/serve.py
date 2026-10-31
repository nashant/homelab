"""Serve opnsense-mcp-server's FastMCP app over streamable HTTP.

Upstream's entrypoint only runs stdio; this imports the same server object
(tools register on import) and runs it on :8080/mcp instead.

OPNSENSE_VERSION ("26.7") skips upstream's lazy version detection, which reads
core/firmware/status: that needs the System: Firmware privilege, which also
grants firmware upgrade and reboot, so the API user doesn't have it.
"""

import os

from opnsense_mcp.api_client import _VERSION_THRESHOLD, OPNsenseAPI
from opnsense_mcp.server import mcp

pinned = os.environ.get("OPNSENSE_VERSION", "").strip()
if pinned:
    major, minor = (int(p) for p in pinned.split(".")[:2])

    async def _pinned_version(self: OPNsenseAPI) -> None:
        self._detected_version = (major, minor)
        self._use_snake_case = self._detected_version >= _VERSION_THRESHOLD

    OPNsenseAPI._ensure_version_detected = _pinned_version  # type: ignore[method-assign]

if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8080)
