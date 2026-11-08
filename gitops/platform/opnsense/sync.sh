#!/bin/bash
# Push the cert-manager certificate in /tls to the OPNsense web GUI through the Trust API.
# Flow and one-time setup: README.md.
set -euo pipefail

HOST=${OPNSENSE_HOST:?}
TMP=$(mktemp -d)

CURL=(curl -sS --fail-with-body -u "$(cat /api/api-key):$(cat /api/api-secret)")
[ -n "${INSECURE:-}" ] && CURL+=(-k)

api() {  # api <path> [json body] -> POST when a body is given
  if [ $# -gt 1 ]; then
    "${CURL[@]}" -H "Content-Type: application/json" -d "$2" "https://${HOST}/api/$1"
  else
    "${CURL[@]}" "https://${HOST}/api/$1"
  fi
}

check_saved() {  # OPNsense answers 200 with {"result":"failed","validations":{...}} on bad input
  jq -e '.result == "saved"' >/dev/null <<<"$1" || { echo "$2: $1" >&2; exit 1; }
}

served() {  # the certificate the GUI serves now; no verification, it is only inspected
  openssl s_client -connect "${HOST}:443" -servername "$HOST" </dev/null 2>/dev/null \
    | openssl x509 -noout "$@"
}

fingerprint() { openssl x509 -noout -fingerprint -sha256 "$@"; }

# tls.crt is the leaf followed by its intermediates: cert1.pem, cert2.pem, ...
awk -v d="$TMP" '/BEGIN CERTIFICATE/ {n++} n {print > (d "/cert" n ".pem")}' /tls/tls.crt
LEAF=$TMP/cert1.pem

echo "served: $(served -subject -issuer -enddate -fingerprint -sha256 | paste -sd ' ')"
if [ "$(served -fingerprint -sha256)" = "$(fingerprint -in "$LEAF")" ]; then
  echo "unchanged"; exit 0
fi
echo "pushing: $(openssl x509 -noout -subject -enddate -fingerprint -sha256 -in "$LEAF" | paste -sd ' ')"

# Intermediates, compared by PEM body without whitespace
existing=$(api trust/ca/search | jq -r '.rows[].crt_payload // "" | gsub("\\s"; "")')
for ca in "$TMP"/cert[2-9]*.pem; do
  [ -e "$ca" ] || continue
  grep -qxF -e "$(tr -d '[:space:]' <"$ca")" <<<"$existing" && continue
  name=$(openssl x509 -noout -subject -nameopt RFC2253 -in "$ca" | sed 's/^subject=//')
  echo "importing CA: $name"
  check_saved "$(api trust/ca/add "$(jq -n --arg descr "$name" --rawfile crt "$ca" \
    '{ca: {action: "existing", descr: $descr, crt_payload: $crt}}')")" "trust/ca/add"
done

body=$(jq -n --arg descr "$HOST" --rawfile crt "$LEAF" --rawfile prv /tls/tls.key \
  '{cert: {action: "import", descr: $descr, cert_type: "usr_cert", private_key_location: "firewall",
           crt_payload: $crt, prv_payload: $prv, csr_payload: ""}}')
certs=$(api trust/cert/search)
mapfile -t uuids < <(jq -r --arg cn "$HOST" '.rows[] | select(.commonname == $cn) | .uuid' <<<"$certs")
case ${#uuids[@]} in
  0)
    check_saved "$(api trust/cert/add "$body")" "trust/cert/add"
    echo "added ${HOST}: select it in System > Settings > Administration > SSL Certificate"
    exit 0 ;;
  1)
    check_saved "$(api "trust/cert/set/${uuids[0]}" "$body")" "trust/cert/set" ;;
  *)
    echo "${#uuids[@]} certificates with CN ${HOST} (${uuids[*]}); delete the extras" >&2
    exit 1 ;;
esac

# The GUI drops the connection while it restarts
api core/service/restart/webgui '{}' >/dev/null 2>&1 || true
sleep 15

echo "served: $(served -subject -issuer -enddate -fingerprint -sha256 | paste -sd ' ')"
if [ "$(served -fingerprint -sha256)" != "$(fingerprint -in "$LEAF")" ]; then
  echo "GUI still serves the old certificate: is ${HOST} selected in System > Settings >" \
    "Administration, and did the API restart reload it?" >&2
  exit 1
fi
echo "updated"
