#!/bin/sh

# Retry transient failures (e.g. DNS); exit non-zero so the pod restarts
# rather than sitting "Running" without the tooling run.sh needs.
for i in 1 2 3 4 5; do
  apk add bash curl jq vim kubectl && exit 0
  echo "apk add failed (attempt $i/5), retrying in 10s" >&2
  sleep 10
done
exit 1
