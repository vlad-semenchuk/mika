# VPS Monitoring Stack Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Prometheus + Grafana to the VPS and make Grafana permanently accessible from the developer's laptop via Tailscale.

**Architecture:** Tailscale is installed on the VPS first (security boundary), then the monitoring stack is started with Docker Compose. Prometheus is locked to localhost; Grafana binds to all interfaces so Tailscale can reach it. CI/CD is extended to keep the stack running after each deploy.

**Tech Stack:** Docker Compose, Prometheus, Grafana, Tailscale, GitHub Actions

---

## Files Modified

| File | Change |
|------|--------|
| `docker-compose.yml` | Lock Prometheus to `127.0.0.1`; use env var for Grafana password |
| `.github/workflows/deploy.yml` | Add `docker compose up -d` after service restart |

## Manual VPS Steps (one-time, not in git)

- Install and auth Tailscale
- Create `/home/mika/mika/.env` with Grafana password

---

## Task 1: Lock Prometheus Port and Parameterise Grafana Password

**Files:**
- Modify: `docker-compose.yml`

On Linux, Docker manipulates iptables directly and bypasses `ufw`. Without an explicit `127.0.0.1` bind, port 9090 is reachable from the public internet regardless of firewall rules. The Grafana password must come from an env var so the real password can be stored in a `.env` file on the VPS that is never committed.

- [ ] **Step 1: Update docker-compose.yml**

Change `docker-compose.yml` to:

```yaml
services:
  prometheus:
    image: prom/prometheus:v3.10.0
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"
    restart: unless-stopped

  grafana:
    image: grafana/grafana-oss:12.4.1
    depends_on:
      - prometheus
    volumes:
      - ./monitoring/grafana/provisioning/datasources:/etc/grafana/provisioning/datasources:ro
      - ./monitoring/grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD}
      GF_USERS_ALLOW_SIGN_UP: "false"
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
```

- [ ] **Step 2: Verify compose config interpolation**

```bash
GF_SECURITY_ADMIN_PASSWORD=testpass docker compose config | grep ADMIN
```

Expected output contains: `GF_SECURITY_ADMIN_PASSWORD: testpass`

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(monitoring): lock prometheus to localhost, parameterise grafana password"
```

---

## Task 2: Extend CI Deploy to Start Monitoring Stack

**Files:**
- Modify: `.github/workflows/deploy.yml`

After each deploy, `docker compose up -d` ensures the monitoring stack is running. `--remove-orphans` cleans up containers from old service definitions. Since `monitoring/` is tracked in git, `git pull` automatically delivers provisioning file updates.

- [ ] **Step 1: Add docker compose step to deploy script**

In `.github/workflows/deploy.yml`, append to the `script` block:

```yaml
script: |
  cd /home/mika/mika
  git stash
  git pull
  npm install
  npm run build
  XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart nanoclaw
  docker compose up -d --remove-orphans
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: start monitoring stack on each deploy"
```

---

## Task 3: Push to Main and Verify CI

- [ ] **Step 1: Push both commits**

```bash
git push origin main
```

- [ ] **Step 2: Watch CI run**

Open GitHub Actions in the browser and confirm the deploy job passes. The `docker compose up -d` step will fail on this first run if the VPS bootstrap hasn't been done yet — that's expected. Proceed to Task 4.

---

## Task 4: Bootstrap VPS (one-time manual steps)

SSH into the VPS: `ssh mika`

- [ ] **Step 1: Install Tailscale**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

- [ ] **Step 2: Authenticate Tailscale**

```bash
sudo tailscale up
```

Open the printed URL in your browser and approve the VPS in the Tailscale admin console. The terminal will confirm once authenticated.

- [ ] **Step 3: Confirm Tailscale IP**

```bash
tailscale ip -4
```

Note this IP — it's your permanent Grafana address (e.g. `100.x.x.x`).

- [ ] **Step 4: Confirm Tailscale persists across reboots**

```bash
sudo systemctl is-enabled tailscaled
```

Expected: `enabled`

- [ ] **Step 5: Create .env file with Grafana password**

```bash
echo "GF_SECURITY_ADMIN_PASSWORD=<choose-a-strong-password>" > /home/mika/mika/.env
chmod 600 /home/mika/mika/.env
```

Replace `<choose-a-strong-password>` with a real password. This file is gitignored and will never be overwritten by `git pull`.

- [ ] **Step 6: Start the monitoring stack**

```bash
cd /home/mika/mika
docker compose up -d
```

Expected output: two containers starting (`prometheus` and `grafana`).

- [ ] **Step 7: Verify containers are running**

```bash
docker compose ps
```

Expected: both services show `running`.

---

## Task 5: Verify End-to-End

Run these from the VPS (still SSH'd in):

- [ ] **Step 1: Prometheus reaches NanoClaw metrics**

```bash
curl -s localhost:9090/api/v1/targets | python3 -c "import sys,json; t=json.load(sys.stdin)['data']['activeTargets'][0]; print(t['health'], t['lastScrapeError'])"
```

Expected: `up ` (empty error string)

- [ ] **Step 2: Prometheus not reachable from public internet**

```bash
curl -s --max-time 3 http://$(curl -s ifconfig.me):9090 || echo "blocked"
```

Expected: `blocked` (connection refused or timeout)

- [ ] **Step 3: Grafana reachable via Tailscale from laptop**

On your **laptop**, open:
```
http://<tailscale-ip>:3001
```

Expected: Grafana login page. Log in with `admin` / `<your-password>`. The NanoClaw dashboard should be pre-provisioned and loading with live data.

- [ ] **Step 4: Verify dashboard has live data**

In Grafana, open the NanoClaw dashboard. Panels for container activity, agent invocations, memory, and event loop lag should show data points (NanoClaw has been running for over a day).

---

## Done

Grafana is live at `http://<tailscale-ip>:3001`. Monitoring stack restarts automatically on VPS reboot and after each CI deploy.
