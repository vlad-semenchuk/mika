#!/bin/sh
set -eu

# Import the NanoClaw dashboard via Grafana API if it doesn't exist yet.
# Runs on container startup, waits for Grafana to be ready, then imports.

GRAFANA_URL="http://localhost:3000"
DASHBOARD_FILE="/var/lib/grafana/dashboards/nanoclaw.json"
DASHBOARD_UID="nanoclaw-v1"
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

# Check if dashboard already exists
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "admin:${GRAFANA_PASSWORD}" \
  "${GRAFANA_URL}/api/dashboards/uid/${DASHBOARD_UID}" 2>/dev/null || true)

if [ "$status" = "200" ]; then
  exit 0
fi

# Build payload: {"dashboard": <json>, "overwrite": false, "folderId": 0}
# No jq available in Grafana image, so construct manually
payload="{\"dashboard\":$(cat "$DASHBOARD_FILE"),\"overwrite\":false,\"folderId\":0}"

curl -s -X POST \
  -u "admin:${GRAFANA_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "${GRAFANA_URL}/api/dashboards/db" > /dev/null
