---
name: whoop
description: Access WHOOP fitness tracker data via API, including recovery scores, sleep metrics, workout stats, daily strain, and body measurements. Use when the user asks about their WHOOP data, fitness metrics, recovery status, sleep quality, workout performance, or wants to track health trends.
---

# WHOOP API (Node.js)

Retrieve and analyze fitness data from WHOOP wearables via the official REST API. Zero dependencies — uses Node.js 18+ built-in `fetch`.

## Usage Snippet
```bash
node whoop.mjs profile
node whoop.mjs recovery --today
node whoop.mjs sleep --last
node whoop.mjs workouts --days 7
node whoop.mjs cycles --days 3
```

## Prerequisites

- Node.js 18+ (uses built-in `fetch`)
- No npm packages required

## Quick Start

### 1. Register Application
- Go to https://developer.whoop.com
- Create a new app and note your `client_id` and `client_secret`
- Set redirect URI (e.g., `http://localhost:3000/callback`)

### 2. Save Credentials
```bash
mkdir -p ~/.whoop
cat > ~/.whoop/credentials.json <<EOF
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
EOF
chmod 600 ~/.whoop/credentials.json
```

### 3. Authorize
- Complete the OAuth authorization flow to obtain tokens
- Tokens are saved to `~/.whoop/token.json` and auto-refreshed

### 4. Fetch Data

```bash
# Today's recovery
node whoop.mjs recovery --today

# Last night's sleep
node whoop.mjs sleep --last

# Recent workouts
node whoop.mjs workouts --days 7

# Daily strain
node whoop.mjs cycles --days 3

# User profile + body measurements
node whoop.mjs profile

# Raw JSON output (any command)
node whoop.mjs recovery --today --json
```

## Commands

### profile
```bash
node whoop.mjs profile            # Profile + body measurements
node whoop.mjs profile --json     # Raw JSON output
```

### recovery
```bash
node whoop.mjs recovery --today              # Today's recovery
node whoop.mjs recovery --days 7              # Past week
node whoop.mjs recovery --start 2026-01-20 --end 2026-01-27
node whoop.mjs recovery --limit 10            # Max records
node whoop.mjs recovery --json                # Raw JSON output
```

### sleep
```bash
node whoop.mjs sleep --last        # Last night
node whoop.mjs sleep --days 7      # Past week
node whoop.mjs sleep --start 2026-01-20 --end 2026-01-27
node whoop.mjs sleep --json        # Raw JSON output
```

### workouts
```bash
node whoop.mjs workouts --days 7              # Past week
node whoop.mjs workouts --sport running        # Filter by sport
node whoop.mjs workouts --start 2026-01-20 --end 2026-01-27
node whoop.mjs workouts --json                 # Raw JSON output
```

### cycles
```bash
node whoop.mjs cycles --today      # Today's strain
node whoop.mjs cycles --days 3     # Past 3 days
node whoop.mjs cycles --json       # Raw JSON output
```

## Core Data Types

### Recovery
- **Recovery Score** (0-100): Readiness for strain
- **HRV (RMSSD)**: Heart rate variability in milliseconds
- **Resting Heart Rate**: Morning baseline HR
- **SPO2**: Blood oxygen percentage
- **Skin Temperature**: Deviation from baseline in C

### Sleep
- **Performance %**: How well you slept vs. your sleep need
- **Duration**: Total time in bed and per stage (REM, SWS, light, awake)
- **Efficiency %**: Time asleep / time in bed
- **Consistency %**: How consistent your sleep schedule is
- **Respiratory Rate**: Breaths per minute
- **Sleep Needed/Debt**: Baseline need and accumulated debt

### Cycle (Daily Strain)
- **Strain Score**: Cardiovascular load (0-21 scale)
- **Kilojoules**: Energy expenditure
- **Average/Max Heart Rate**: Daily HR metrics

### Workout
- **Strain**: Activity-specific strain score
- **Sport**: Activity type (running, cycling, etc.)
- **Heart Rate Zones**: Time spent in each of 6 zones
- **Distance/Altitude**: GPS metrics (if available)

## API Endpoints

Base URL: `https://api.prod.whoop.com/developer`

**User Profile:**
- `GET /v2/user/profile/basic` -- Name, email
- `GET /v2/user/measurement/body` -- Height, weight, max HR

**Recovery:**
- `GET /v2/recovery` -- All recovery data (paginated)
- `GET /v2/recovery/{recoveryId}` -- Specific recovery by ID
- `GET /v2/cycle/{cycleId}/recovery` -- Recovery for specific cycle

**Sleep:**
- `GET /v2/activity/sleep` -- All sleep records (paginated)
- `GET /v2/activity/sleep/{sleepId}` -- Specific sleep by ID
- `GET /v2/cycle/{cycleId}/sleep` -- Sleep for specific cycle

**Cycle:**
- `GET /v2/cycle` -- All physiological cycles (paginated)
- `GET /v2/cycle/{cycleId}` -- Specific cycle by ID

**Workout:**
- `GET /v2/activity/workout` -- All workouts (paginated)
- `GET /v2/activity/workout/{workoutId}` -- Specific workout by ID

All collection endpoints support `start`, `end` (ISO 8601), `limit` (max 25), and `nextToken` (pagination cursor).

## Required OAuth Scopes

- `read:profile` -- User name and email
- `read:body_measurement` -- Height, weight, max HR
- `read:recovery` -- Recovery scores and HRV
- `read:sleep` -- Sleep metrics and stages
- `read:cycles` -- Daily strain data
- `read:workout` -- Activity and workout data

## Scripts

### `whoop-client.mjs`
Core API client. Features:
- OAuth token storage and auto-refresh
- Token expiry tracking (proactive refresh 60s before expiry)
- Rate limit handling (429 with Retry-After)
- Automatic pagination iterators (`iterRecovery`, `iterSleep`, `iterCycles`, `iterWorkouts`)
- Zero dependencies (Node 18+ built-in `fetch`)

### `whoop.mjs`
CLI entry point with subcommands: `profile`, `recovery`, `sleep`, `workouts`, `cycles`.
Supports `--today`, `--last`, `--days`, `--start/--end`, `--limit`, `--sport`, `--json` flags.

## Troubleshooting

### "Credentials not found at ~/.whoop/credentials.json"
Create the file with your OAuth client_id and client_secret (see Quick Start step 2).

### "Not authenticated"
Complete the OAuth authorization flow to save tokens to `~/.whoop/token.json`.

### "Token refresh failed"
Your refresh token has expired. Re-authorize from the authorization URL.

### "API error 429"
Rate limit hit. The client automatically retries after the `Retry-After` period.

### Empty results
Check your date range -- use `--days 7` or wider range. Ensure your OAuth scopes include the data type you're requesting.
