#!/bin/bash

set -euo pipefail

readonly SCRIPT_DIR=$(cd $(dirname "${BASH_SOURCE[0]}") && pwd)
source "${SCRIPT_DIR}/utils.sh"

export PF_TARGET_ALIAS_UUID=$(opnsense firewall/alias/getAliasUUID/${PF_TARGET_ALIAS_NAME} | jq -r .uuid)
stderr "UUID for alias $PF_TARGET_ALIAS_NAME - $PF_TARGET_ALIAS_UUID"

export PF_PORT_ALIAS_UUID=$(opnsense firewall/alias/getAliasUUID/${PF_PORT_ALIAS_NAME} | jq -r .uuid)
stderr "UUID for alias $PF_PORT_ALIAS_NAME - $PF_PORT_ALIAS_UUID"

export CURRENT_PF_TARGET_IP=$(kubectl get pod -n ${PF_TARGET_NAMESPACE} -l ${PF_TARGET_LABEL} -o jsonpath='{.items[0].status.podIP}')
stderr "IP for current port-forward target pod - $CURRENT_PF_TARGET_IP"

pia_token=$( get_token )
pf_gateway=$( get_gateway )
read payload signature <<< $(get_payload_and_signature "$pf_gateway" "$pia_token")
read port expires_at <<< $(unpack_payload "$payload")

update_port "$port"
# The watch only sees changes, so sync the target alias to the current pod first
echo "$CURRENT_PF_TARGET_IP" | update_pf_target_ip
watch_and_update_target &

while true; do
  pf_keepalive "$pf_gateway" "$payload" "$signature"
  sleep 600  # 10 minutes
done
