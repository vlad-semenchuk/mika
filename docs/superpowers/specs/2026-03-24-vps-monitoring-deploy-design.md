# VPS Monitoring Stack Deployment

**Date:** 2026-03-24
**Status:** Approved

## Goal

Deploy the Prometheus + Grafana monitoring stack to the VPS (`ssh mika`) and make Grafana permanently accessible from the developer's laptop via Tailscale.

## Context

- NanoClaw runs on the VPS as a systemd user service, exposing `/metrics` on `localhost:9091`
- `docker-compose.yml` with Prometheus + Grafana already exists locally but has never been deployed to the VPS
- The `monitoring/` directory does not exist on the VPS yet
- CI/CD deploys via GitHub Actions (`.github/workflows/deploy.yml`) on push to `main`
- Developer has a Tailscale free account (supports 100 devices); Tailscale is not yet installed on the VPS

## Architecture

```
Laptop ──[Tailscale]──► VPS (100.x.x.x)
                           ├── NanoClaw     :9091  (localhost only)
                           ├── Prometheus   :9090  (localhost only)
                           └── Grafana      :3001  (0.0.0.0 — Tailscale-accessible)
                                    scrapes ▲
                           host.docker.internal:9091
```

Grafana binds to all interfaces so Tailscale can route to it. Prometheus is localhost-only. Public firewall keeps both ports blocked — Tailscale handles private routing transparently.

## Components

### 1. Tailscale on VPS
- Install via official script: `curl -fsSL https://tailscale.com/install.sh | sh`
- Auth: `tailscale up` (one-time browser login)
- `tailscaled` runs as a systemd service, auto-starts on reboot
- After auth, VPS gets a stable Tailscale IP (e.g. `100.x.x.x`)

### 2. Docker Compose Stack
- `docker-compose.yml` already correct — `restart: unless-stopped` on both services
- `host.docker.internal:host-gateway` already configured — Prometheus reaches host metrics
- Grafana provisioning files (`datasources/`, `dashboards/`) already in `monitoring/`
- No changes needed to compose file

### 3. Grafana Password
- Change `GF_SECURITY_ADMIN_PASSWORD` from default `admin` before deploy
- Store in `.env` file on VPS (gitignored), referenced in `docker-compose.yml`

### 4. Deploy Workflow Update
- Add `docker compose up -d` to `.github/workflows/deploy.yml` after the `systemctl restart` line
- Ensures monitoring stack is always running after each deploy
- First deploy: manually `scp` or `rsync` the `monitoring/` directory to the VPS, then `git pull` handles future updates since `monitoring/` is tracked in git

### 5. Firewall
- No changes needed — ports 9090 and 3001 stay closed to the public internet
- Tailscale traffic is routed at the network level and bypasses public firewall rules

## Access

After setup, Grafana is available at:
```
http://<tailscale-ip>:3001
```

Always on (monitoring stack restarts on reboot and on each deploy). Always private (Tailscale only).

## Out of Scope

- HTTPS/TLS (Tailscale traffic is encrypted end-to-end; HTTP over Tailscale is acceptable)
- Prometheus external access
- Alerting (future milestone)
