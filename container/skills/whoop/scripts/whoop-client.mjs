import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = 'https://api.prod.whoop.com/developer';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_DIR = join(homedir(), '.whoop');
const CREDENTIALS_PATH = join(WHOOP_DIR, 'credentials.json');
const TOKEN_PATH = join(WHOOP_DIR, 'token.json');

export class WhoopClient {
  constructor() {
    this.baseUrl = BASE_URL;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = null;
    this._loadToken();
  }

  _loadCredentials() {
    if (!existsSync(CREDENTIALS_PATH)) {
      throw new Error(
        `Credentials not found at ${CREDENTIALS_PATH}\n` +
        'Create the file with: {"client_id": "...", "client_secret": "..."}'
      );
    }
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
    if (!creds.client_id || !creds.client_secret) {
      throw new Error('credentials.json missing required fields: client_id, client_secret');
    }
    return creds;
  }

  _loadToken() {
    if (!existsSync(TOKEN_PATH)) return;
    try {
      const data = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
      this.accessToken = data.access_token || null;
      this.refreshToken = data.refresh_token || null;
      if (data.expires_at) {
        this.tokenExpiresAt = new Date(data.expires_at);
      }
    } catch {
      // Corrupted token file — ignore
    }
  }

  _saveToken(accessToken, refreshToken = null, expiresIn = 3600) {
    mkdirSync(WHOOP_DIR, { recursive: true });
    const now = new Date();
    const data = {
      access_token: accessToken,
      refresh_token: refreshToken || this.refreshToken,
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    };
    writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
    chmodSync(TOKEN_PATH, 0o600);
    this.accessToken = accessToken;
    this.tokenExpiresAt = new Date(now.getTime() + expiresIn * 1000);
    if (refreshToken) this.refreshToken = refreshToken;
  }

  _isTokenExpired() {
    if (!this.tokenExpiresAt) return false;
    return Date.now() >= this.tokenExpiresAt.getTime() - 60_000;
  }

  async authenticate(authorizationCode, redirectUri) {
    const creds = this._loadCredentials();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Auth failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this._saveToken(data.access_token, data.refresh_token, data.expires_in || 3600);
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Re-run the authorization flow.');
    }
    const creds = this._loadCredentials();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    this._saveToken(data.access_token, data.refresh_token, data.expires_in || 3600);
  }

  async _request(method, endpoint, params = null) {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Run authenticate() first or obtain a token.');
    }

    if (this._isTokenExpired() && this.refreshToken) {
      await this._refreshAccessToken();
    }

    let url = `${this.baseUrl}${endpoint}`;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v != null) qs.set(k, String(v));
      }
      const qsStr = qs.toString();
      if (qsStr) url += `?${qsStr}`;
    }

    const headers = { Authorization: `Bearer ${this.accessToken}` };
    let res = await fetch(url, { method, headers });

    if (res.status === 401 && this.refreshToken) {
      await this._refreshAccessToken();
      headers.Authorization = `Bearer ${this.accessToken}`;
      res = await fetch(url, { method, headers });
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      process.stderr.write(`Rate limited. Retrying in ${retryAfter} seconds...\n`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      res = await fetch(url, { method, headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async get(endpoint, params = null) {
    return this._request('GET', endpoint, params);
  }

  // --- User endpoints ---

  async getProfile() {
    return this.get('/v2/user/profile/basic');
  }

  async getBodyMeasurements() {
    return this.get('/v2/user/measurement/body');
  }

  // --- Recovery endpoints ---

  async getRecoveryCollection(start, end, limit = 25, nextToken = null) {
    const params = { limit };
    if (start) params.start = start;
    if (end) params.end = end;
    if (nextToken) params.nextToken = nextToken;
    return this.get('/v2/recovery', params);
  }

  async getRecoveryById(recoveryId) {
    return this.get(`/v2/recovery/${recoveryId}`);
  }

  async getRecoveryForCycle(cycleId) {
    return this.get(`/v2/cycle/${cycleId}/recovery`);
  }

  async *iterRecovery(start, end) {
    let nextToken = null;
    do {
      const resp = await this.getRecoveryCollection(start, end, 25, nextToken);
      for (const record of resp.records || []) yield record;
      nextToken = resp.next_token || null;
    } while (nextToken);
  }

  // --- Sleep endpoints ---

  async getSleepCollection(start, end, limit = 25, nextToken = null) {
    const params = { limit };
    if (start) params.start = start;
    if (end) params.end = end;
    if (nextToken) params.nextToken = nextToken;
    return this.get('/v2/activity/sleep', params);
  }

  async getSleepById(sleepId) {
    return this.get(`/v2/activity/sleep/${sleepId}`);
  }

  async getSleepForCycle(cycleId) {
    return this.get(`/v2/cycle/${cycleId}/sleep`);
  }

  async *iterSleep(start, end) {
    let nextToken = null;
    do {
      const resp = await this.getSleepCollection(start, end, 25, nextToken);
      for (const record of resp.records || []) yield record;
      nextToken = resp.next_token || null;
    } while (nextToken);
  }

  // --- Cycle endpoints ---

  async getCycleCollection(start, end, limit = 25, nextToken = null) {
    const params = { limit };
    if (start) params.start = start;
    if (end) params.end = end;
    if (nextToken) params.nextToken = nextToken;
    return this.get('/v2/cycle', params);
  }

  async getCycleById(cycleId) {
    return this.get(`/v2/cycle/${cycleId}`);
  }

  async *iterCycles(start, end) {
    let nextToken = null;
    do {
      const resp = await this.getCycleCollection(start, end, 25, nextToken);
      for (const record of resp.records || []) yield record;
      nextToken = resp.next_token || null;
    } while (nextToken);
  }

  // --- Workout endpoints ---

  async getWorkoutCollection(start, end, limit = 25, nextToken = null) {
    const params = { limit };
    if (start) params.start = start;
    if (end) params.end = end;
    if (nextToken) params.nextToken = nextToken;
    return this.get('/v2/activity/workout', params);
  }

  async getWorkoutById(workoutId) {
    return this.get(`/v2/activity/workout/${workoutId}`);
  }

  async *iterWorkouts(start, end) {
    let nextToken = null;
    do {
      const resp = await this.getWorkoutCollection(start, end, 25, nextToken);
      for (const record of resp.records || []) yield record;
      nextToken = resp.next_token || null;
    } while (nextToken);
  }
}
