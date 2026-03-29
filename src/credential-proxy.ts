/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Containers are given ANTHROPIC_API_KEY=placeholder so the
 *             CLI skips the OAuth exchange entirely. The proxy strips the
 *             placeholder x-api-key and injects a real OAuth Bearer token
 *             (read fresh from ~/.claude/.credentials.json) on every request.
 *             This avoids the create_api_key exchange which requires a scope
 *             that gets lost on token refresh.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Read the current OAuth access token from ~/.claude/.credentials.json.
 * This file is kept up-to-date by Claude Code's token refresh flow,
 * so reading it on each request ensures we always use a valid token.
 * Falls back to last known good token, then to .env values.
 */
let lastGoodToken: string | undefined;
let lastTokenExpiresAt: number | undefined;

function readOAuthToken(envFallback?: string): string | undefined {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (token) {
      const changed = token !== lastGoodToken;
      if (changed) {
        logger.info(
          {
            tokenPrefix: token.slice(0, 25),
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : 'unknown',
            expired: expiresAt ? Date.now() > expiresAt : 'unknown',
          },
          'OAuth token loaded from credentials file',
        );
      }
      lastGoodToken = token;
      lastTokenExpiresAt = expiresAt;
      return token;
    }
  } catch (err) {
    // credentials file missing or being written — use last known good token
    logger.warn({ err, hasLastGood: !!lastGoodToken }, 'Failed to read credentials file');
    if (lastGoodToken) return lastGoodToken;
  }
  if (envFallback) {
    logger.debug('Using .env fallback token');
  }
  return envFallback;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOauthFallback =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const MAX_AUTH_RETRIES = 2;
  const AUTH_RETRY_DELAY_MS = 1000;

  function buildHeaders(
    incomingHeaders: Record<string, string>,
    bodyLength: number,
  ): Record<string, string | number | string[] | undefined> {
    const headers: Record<string, string | number | string[] | undefined> = {
      ...incomingHeaders,
      host: upstreamUrl.host,
      'content-length': bodyLength,
    };
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (authMode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
    } else {
      delete headers['x-api-key'];
      delete headers['authorization'];
      const currentToken = readOAuthToken(envOauthFallback);
      if (currentToken) {
        headers['x-api-key'] = currentToken;
      }
    }
    return headers;
  }

  function sendUpstream(
    reqMethod: string,
    reqUrl: string,
    headers: Record<string, string | number | string[] | undefined>,
    body: Buffer,
    res: import('http').ServerResponse,
    attempt: number,
  ): void {
    const upstream = makeRequest(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: reqUrl,
        method: reqMethod,
        headers,
      } as RequestOptions,
      (upRes) => {
        if (upRes.statusCode === 401 && attempt < MAX_AUTH_RETRIES) {
          // Buffer the error response for logging, then retry
          const errChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => errChunks.push(c));
          upRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString('utf-8').slice(0, 500);
            logger.warn(
              {
                status: 401,
                attempt,
                method: reqMethod,
                path: reqUrl,
                tokenPrefix: (headers['x-api-key'] as string)?.slice(0, 25) || 'none',
                tokenExpired: lastTokenExpiresAt ? Date.now() > lastTokenExpiresAt : 'unknown',
                body: errBody,
              },
              'Proxy got 401, retrying with fresh token',
            );
            setTimeout(() => {
              // Re-read token for retry (may have been refreshed)
              const retryHeaders = buildHeaders(
                Object.fromEntries(
                  Object.entries(headers).filter(([, v]) => typeof v === 'string') as [string, string][],
                ),
                body.length,
              );
              sendUpstream(reqMethod, reqUrl, retryHeaders, body, res, attempt + 1);
            }, AUTH_RETRY_DELAY_MS);
          });
          return;
        }

        if (upRes.statusCode && upRes.statusCode >= 400) {
          const errChunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => errChunks.push(c));
          upRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString('utf-8').slice(0, 500);
            logger.warn(
              {
                status: upRes.statusCode,
                attempt,
                method: reqMethod,
                path: reqUrl,
                tokenPrefix: (headers['x-api-key'] as string)?.slice(0, 25) || 'none',
                tokenExpired: lastTokenExpiresAt ? Date.now() > lastTokenExpiresAt : 'unknown',
                body: errBody,
              },
              'Proxy upstream error response',
            );
            res.writeHead(upRes.statusCode!, upRes.headers);
            res.end(Buffer.concat(errChunks));
          });
        } else {
          res.writeHead(upRes.statusCode!, upRes.headers);
          upRes.pipe(res);
        }
      },
    );

    upstream.on('error', (err) => {
      logger.error({ err, url: reqUrl }, 'Credential proxy upstream error');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = buildHeaders(
          req.headers as Record<string, string>,
          body.length,
        );
        sendUpstream(req.method || 'GET', req.url || '/', headers, body, res, 0);
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
