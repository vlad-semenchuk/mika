import http from 'http';

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Singleton registry — import this everywhere metrics are defined.
// Never use prom-client's global `register`; always use this custom instance.
export const registry = new Registry();

// Collect default Node.js/process metrics once at module scope.
collectDefaultMetrics({ register: registry });

// Container lifecycle metrics (CONT-01 to CONT-04)

/** Counts total container spawns per group. */
export const containerSpawnTotal = new Counter({
  name: 'nanoclaw_container_spawn_total',
  help: 'Total number of container spawns per group',
  labelNames: ['group'] as const,
  registers: [registry],
});

/** Counts container failures with reason label. */
export const containerFailureTotal = new Counter({
  name: 'nanoclaw_container_failure_total',
  help: 'Total number of container failures per group and reason (timeout, exit_error, spawn_error)',
  labelNames: ['group', 'reason'] as const,
  registers: [registry],
});

/** Histogram of container run durations in seconds. */
export const containerDurationSeconds = new Histogram({
  name: 'nanoclaw_container_duration_seconds',
  help: 'Container run duration in seconds',
  labelNames: ['group'] as const,
  buckets: [5, 10, 20, 30, 60, 90, 120, 180, 300, 600],
  registers: [registry],
});

/** Gauge tracking how many containers are currently running. */
export const containersActive = new Gauge({
  name: 'nanoclaw_containers_active',
  help: 'Number of currently active (running) containers',
  registers: [registry],
});

// Agent invocation metrics (AGNT-01 to AGNT-02)

/** Counts total agent invocations. */
export const agentInvocationTotal = new Counter({
  name: 'nanoclaw_agent_invocation_total',
  help: 'Total number of agent invocations',
  registers: [registry],
});

/** Histogram of agent end-to-end durations in seconds. */
export const agentDurationSeconds = new Histogram({
  name: 'nanoclaw_agent_duration_seconds',
  help: 'Agent end-to-end duration in seconds (from invocation to completion)',
  buckets: [5, 10, 20, 30, 60, 90, 120, 180, 300, 600],
  registers: [registry],
});

let server: http.Server | null = null;

/**
 * Start the Prometheus metrics HTTP server on the given port.
 * Binds to the specified address (default 0.0.0.0).
 * Serves GET /metrics → 200 with Prometheus text format.
 * All other paths → 404.
 */
export function startMetricsServer(port: number, bind = '0.0.0.0'): void {
  server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const body = await registry.metrics();
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(body);
      } catch (err) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, bind);
}

/**
 * Returns the underlying HTTP server instance, or null if not started.
 * Exposed for testing purposes only.
 */
export function getMetricsServer(): http.Server | null {
  return server;
}

/**
 * Stop the metrics HTTP server gracefully.
 * Safe to call even if the server is not running.
 */
export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
