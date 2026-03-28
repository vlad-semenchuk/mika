#!/bin/sh
set -eu

# Import or update the NanoClaw dashboard via Grafana API.
# Runs on container startup, waits for Grafana to be ready, then upserts.

GRAFANA_URL="http://localhost:3000"
DASHBOARD_FILE="/var/lib/grafana/dashboards/nanoclaw.json"
GRAFANA_PASSWORD="${GF_SECURITY_ADMIN_PASSWORD:-admin}"

# Wait for Grafana API to be ready
i=0
while [ $i -lt 30 ]; do
  if curl -sf "${GRAFANA_URL}/api/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
  i=$((i + 1))
done

# Build payload with overwrite:true so dashboard updates propagate
payload="{\"dashboard\":$(cat "$DASHBOARD_FILE"),\"overwrite\":true,\"folderId\":0}"

curl -s -X POST \
  -u "admin:${GRAFANA_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "${GRAFANA_URL}/api/dashboards/db" > /dev/null
