stderr() {
  local msg="$1"
  echo "$msg" > /dev/stderr
}

opnsense() {
  # The web GUI is HTTPS-only (HTTP 301s) with a self-signed cert for opnsense.home, hence -k
  local URL="https://${OPNSENSE_HOST}/api/$1" DATA="${2:-}" METHOD="GET" ARGS=()
  if [ -n "$DATA" ]; then
    METHOD="POST"
    ARGS+=(-H "Content-Type: application/json" -d "$DATA")
  fi
  curl -k -X "${METHOD}" "${ARGS[@]}" -su "$OPNSENSE_KEY:$OPNSENSE_PASS" "$URL"
}

get_token() {
  # Public token API (as upstream pia-foss/manual-connections get_token.sh).
  # Region meta servers can present non-PIA certs (e.g. ExpressVPN CA3).
  stderr "Trying to get a new token from the PIA token API..."
  generateTokenResponse=$(curl -s --location --request POST \
    'https://www.privateinternetaccess.com/api/client/v2/token' \
    --form "username=$PIA_USER" \
    --form "password=$PIA_PASS")

  token=$(echo "$generateTokenResponse" | jq -r '.token // empty')
  if [ -z "$token" ]; then
    stderr "Could not get a token. Response: ${generateTokenResponse:0:200}"
    exit 1
  fi

  echo "$token"
}

get_gateway() {
  stderr "Trying to get gateway for interface ${OPNSENSE_IF}..."
  # First host of the tunnel subnet, for any prefix length (e.g. 10.68.192.255/18 -> 10.68.192.1)
  gateway=$(opnsense "interfaces/overview/getInterface/${OPNSENSE_IF}/" | jq -r '
    .message.addr4.value // empty | split("/") | (.[1]|tonumber) as $p
    | (.[0] | split(".") | map(tonumber) | .[0]*16777216 + .[1]*65536 + .[2]*256 + .[3]) as $ip
    | (pow(2; 32 - $p)) as $size | (($ip / $size | floor) * $size + 1) as $gw
    | [($gw/16777216|floor), ($gw/65536|floor)%256, ($gw/256|floor)%256, $gw%256] | map(tostring) | join(".")')
  if [ -z "$gateway" ]; then
    stderr "Could not get PIA gateway"
    exit 1
  fi
  stderr "PIA gateway: $gateway"
  echo "$gateway"
}

get_payload_and_signature() {
  local GATEWAY="$1" TOKEN="$2"
  stderr "Fetching payload and signature..."
  local response=$(curl -skm 5 \
    --connect-to "$PIA_CN::$GATEWAY:" \
    --cacert "${SCRIPT_DIR}/ca.rsa.4096.crt" \
    -G --data-urlencode "token=${TOKEN}" \
    "https://${PIA_CN}:19999/getSignature")
  if [ "$(echo "$response" | jq -r '.status // empty' 2>/dev/null)" != "OK" ]; then
    stderr "Could not get payload and signature. Response: ${response:0:200}"
    exit 1
  fi
  echo "$response" | jq -r '.payload + " " + .signature'
  stderr "Fetched payload and signature"
}

pf_keepalive() {
  local GATEWAY="$1" PAYLOAD="$2" SIGNATURE="$3"
  local response=$(curl -sk --connect-to "$PIA_CN::$GATEWAY:" \
    --cacert ${SCRIPT_DIR}/ca.rsa.4096.crt \
    -G --data-urlencode "payload=$PAYLOAD" \
    --data-urlencode "signature=$SIGNATURE" \
    "https://$PIA_CN:19999/bindPort")
  echo "$response"
}

unpack_payload() {
  echo "$1" | base64 -d | jq -r '(.port|tostring) + " " + .expires_at'
}

update_alias() {
  local UUID="$1" NAME="$2" CONTENT="$3"
  stderr "Updating alias $NAME with content $CONTENT"
  update=$(opnsense firewall/alias/setItem/$UUID "{\"alias\":{\"content\":\"$CONTENT\"}}")
  stderr "Updated, reconfiguring..."
  reconfigure=$(opnsense firewall/alias/reconfigure '{}')
  stderr "Done"
}

update_pf_target_ip() {
  local NEW_IP; read -r NEW_IP || return

  stderr "New pod found with IP ${NEW_IP}"
  update_alias "$PF_TARGET_ALIAS_UUID" "$PF_TARGET_ALIAS_NAME" "$NEW_IP"
}

watch_and_update_target() {
  stderr "Starting watching for pod changes"
  while true; do
    while read -r JSON; do
      NEW_IP=$(jq -r '
        . | select(
          .object.metadata.deletionTimestamp==null and
          .object.status.phase=="Running" and
          .object.status.podIP!=null
        ) | .object.status.podIP
      ' <<< "$JSON")
      if [[ -n "$NEW_IP" && "$NEW_IP" != "$CURRENT_PF_TARGET_IP" ]]; then
        export CURRENT_PF_TARGET_IP="$NEW_IP"
        echo "$NEW_IP" | update_pf_target_ip
      fi
    done < <(kubectl get pod -n ${PF_TARGET_NAMESPACE} -l ${PF_TARGET_LABEL} -o json --watch-only --output-watch-events)
    stderr "Watch ended, restarting..."
  done
}

update_port() {
  local PORT="$1"
  if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    stderr "Refusing to set invalid port '$PORT'"
    exit 1
  fi
  update_alias "$PF_PORT_ALIAS_UUID" "$PF_PORT_ALIAS_NAME" "$PORT"
  # qBittorrent keeps a fixed listen port (OPNsense NATs the PIA port onto it), so only
  # the port announced to trackers/DHT changes. Changing listen_port live made libtorrent
  # rebind, which can fail with "Address in use" and leave it listening on localhost only.
  curl -s http://qbittorrent.media.svc.cluster.local:8080/api/v2/app/setPreferences -d "json={\"announce_port\":$PORT}"
}
