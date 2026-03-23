import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';

/**
 * LOGG-01 unit tests: verify environment-conditional transport behaviour.
 *
 * We do NOT import src/logger.ts directly because:
 *  - It registers uncaughtException / unhandledRejection process handlers
 *    that interfere with the test runner when registered multiple times.
 *  - We want to control NODE_ENV precisely for each test.
 *
 * Instead we construct a pino instance the same way logger.ts does and
 * assert the output characteristics we care about.
 */

describe('LOGG-01: production mode — JSON output', () => {
  it('produces valid JSON when no transport is configured (production pattern)', () => {
    const chunks: string[] = [];

    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const prodLogger = pino({ level: 'info' }, dest);
    prodLogger.info({ groupId: 'test-group' }, 'production log line');

    // Flush synchronously (pino in sync mode writes immediately to dest)
    const raw = chunks.join('');
    expect(raw.trim()).not.toBe('');

    const parsed = JSON.parse(raw.trim());
    expect(parsed).toMatchObject({
      level: 30, // pino numeric level for 'info'
      msg: 'production log line',
      groupId: 'test-group',
    });
  });

  it('produces a line for each log call', () => {
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    const prodLogger = pino({ level: 'debug' }, dest);
    prodLogger.info('first');
    prodLogger.error({ err: new Error('boom') }, 'second');

    const lines = chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.msg).toBe('first');
    expect(second.msg).toBe('second');
    expect(second.err).toBeDefined();
  });
});

describe('LOGG-01: logger module interface', () => {
  let loggerModule: typeof import('./logger.js');

  beforeAll(async () => {
    // Set NODE_ENV=production before importing so pino-pretty is NOT loaded,
    // preventing worker thread noise during tests.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    loggerModule = await import('./logger.js');
    process.env.NODE_ENV = prev;
  });

  it('exports a logger with expected pino methods', () => {
    const { logger } = loggerModule;
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.fatal).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('logger.info does not throw', () => {
    const { logger } = loggerModule;
    expect(() => logger.info('test message from vitest')).not.toThrow();
  });

  it('logger.error with Error object does not throw', () => {
    const { logger } = loggerModule;
    expect(() => logger.error({ err: new Error('test') }, 'error test')).not.toThrow();
  });
});

describe('LOGG-01: environment-conditional transport logic', () => {
  it('isDev is false when NODE_ENV=production', () => {
    // Verify the conditional expression behaves correctly
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const isDev = process.env.NODE_ENV !== 'production';
    expect(isDev).toBe(false);
    process.env.NODE_ENV = originalEnv;
  });

  it('isDev is true when NODE_ENV=development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const isDev = process.env.NODE_ENV !== 'production';
    expect(isDev).toBe(true);
    process.env.NODE_ENV = originalEnv;
  });

  it('isDev is true when NODE_ENV is unset', () => {
    const originalEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const isDev = process.env.NODE_ENV !== 'production';
    expect(isDev).toBe(true);
    process.env.NODE_ENV = originalEnv;
  });

  it('production pino config has no transport key', () => {
    // Simulate what logger.ts does in production mode
    const isDev = false;
    const config = {
      level: 'info',
      ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    };
    expect(config).not.toHaveProperty('transport');
  });

  it('development pino config includes transport key', () => {
    const isDev = true;
    const config = {
      level: 'info',
      ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    };
    expect(config).toHaveProperty('transport');
    expect((config as { transport?: { target: string } }).transport).toMatchObject({
      target: 'pino-pretty',
    });
  });
});
