#!/usr/bin/env bash
# Install gVisor (runsc) on a k3s node and register the runtime class handler.
#
# ⚠ LONGHORN-SAFE MAINTENANCE — REQUIRED READING ⚠
# Restarting k3s (or draining) without evicting Longhorn replicas first WILL
# fault volumes (learned the hard way 2026-10-23: 36 faulted volumes after
# force-drains with --disable-eviction). Never use --disable-eviction/--force
# on this cluster. Per node:
#
#   N=amd64-X
#   kubectl cordon $N
#   # 1. ask Longhorn to move replicas off this node and WAIT for rebuild:
#   kubectl patch nodes.longhorn.io $N -n longhorn-system --type=merge \
#     -p '{"spec":{"evictionRequested":true}}'
#   # 2. wait until scheduled replicas on the node hit 0 and volumes are healthy:
#   kubectl get nodes.longhorn.io $N -n longhorn-system -o jsonpath='{.status.diskStatus.*.scheduledReplica}'
#   kubectl get volumes.longhorn.io -n longhorn-system   # all robustness=healthy
#   # 3. only now drain (plain, no --force/--disable-eviction) and do the work:
#   kubectl drain $N --ignore-daemonsets --delete-emptydir-data --timeout=300s
#   ssh "$N" 'sudo bash -s' < node-prep-runsc.sh offline
#   ssh "$N" 'sudo bash -s' < node-prep-runsc.sh activate
#   kubectl wait --for=condition=ready node/$N --timeout=240s && kubectl uncordon $N
#   # 4. end eviction so replicas rebalance back:
#   kubectl patch nodes.longhorn.io $N -n longhorn-system --type=merge \
#     -p '{"spec":{"evictionRequested":false}}'
#
# OFFLINE MODE: this cluster's nodes cannot resolve external names (port 53
# blocked on the LAN for them — see README), so the apt-based "prepare" fails.
# Use "offline" instead: ship the binaries from a machine with working DNS:
#
#   # workstation (once):
#   curl -LO https://github.com/google/gvisor/releases/download/release-YYYYMMDD.N/gvisor-x86_64.tar.zstd
#   curl -LO https://github.com/google/gvisor/releases/download/release-YYYYMMDD.N/SHA256SUMS
#   grep gvisor-x86_64.tar.zstd SHA256SUMS | sha256sum -c - && tar --zstd -xf gvisor-x86_64.tar.zstd
#   # per node (BEFORE any drain — needs no network):
#   ssh "$n" mkdir -p /tmp/gvisor-bins
#   scp -r runsc containerd-shim-runsc-v1 gvisor-bin "$n":/tmp/gvisor-bins/
#   ssh "$n" 'sudo bash -s' < node-prep-runsc.sh offline
#
set -euo pipefail
MODE="${1:-all}"

install_binaries() {
  # k3s's embedded containerd only looks for shims in its own bin dir
  BIN_DIR=/var/lib/rancher/k3s/data/current/bin
  ln -sf "$(command -v runsc)" "$BIN_DIR/runsc"
  ln -sf "$(command -v containerd-shim-runsc-v1)" "$BIN_DIR/containerd-shim-runsc-v1"

  # Register the runtime. IMPORTANT: k3s REGENERATES config.toml on start and
  # imports drop-ins from config-v3.toml.d/ (containerd 3.x / k3s v1.37+; the
  # plugin is io.containerd.cri.v1.runtime there — NOT the old
  # io.containerd.grpc.v1.cri). Older k3s used conf.d/ with the v2 name.
  install -d -m 0755 /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
  cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/runsc.toml <<'EOF'
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
  sandboxer = "podsandbox"
EOF
  # remove stale attempts from other mechanisms, if present
  rm -f /var/lib/rancher/k3s/agent/etc/containerd/conf.d/runsc.toml
}

prepare() {
  # gVisor apt repository
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://gvisor.io/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor.gpg
  echo "deb [signed-by=/usr/share/keyrings/gvisor.gpg] https://storage.googleapis.com/gvisor/releases/release/main amd64/" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq
  apt-get install -y runsc containerd-shim-runsc-v1
  install_binaries
  echo "prepare done"
}

offline() {
  # Install pre-shipped binaries from /tmp/gvisor-bins (no network needed).
  # gvisor-bin/ sidecars are required: runsc looks for them in
  # <dir-of-runsc>/gvisor-bin/ — without them sandboxes fail with
  # 'sidecar "gvisor_sentry" not usable'.
  install -m 0755 /tmp/gvisor-bins/runsc /usr/local/bin/runsc
  install -m 0755 /tmp/gvisor-bins/containerd-shim-runsc-v1 /usr/local/bin/containerd-shim-runsc-v1
  install -d -m 0755 /usr/local/bin/gvisor-bin
  for f in /tmp/gvisor-bins/gvisor-bin/*; do
    install -m 0755 "$f" "/usr/local/bin/gvisor-bin/$(basename "$f")"
  done
  /usr/local/bin/runsc --version | head -1
  install_binaries
  echo "offline prepare done"
}

activate() {
  systemctl restart k3s   # k3s-agent on worker-only nodes
  echo "activate done (k3s restarted)"
}

case "$MODE" in
  prepare) prepare ;;
  offline) offline ;;
  activate) activate ;;
  all) prepare; activate ;;
esac

