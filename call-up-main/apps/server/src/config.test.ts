import { describe, expect, it } from 'vitest';
import { createServerConfig } from './config.js';

describe('createServerConfig', () => {
  it('requires an explicit SESSION_TOKEN_SECRET in production', () => {
    expect(() =>
      createServerConfig({
        NODE_ENV: 'production'
      })
    ).toThrow(/SESSION_TOKEN_SECRET/);
  });

  it('accepts a shared SESSION_TOKEN_SECRET in production', () => {
    const config = createServerConfig({
      NODE_ENV: 'production',
      SESSION_TOKEN_SECRET: 'shared-prod-secret'
    });

    expect(config.isProduction).toBe(true);
    expect(config.sessionTokenSecret).toBe('shared-prod-secret');
  });

  it('uses a development fallback secret outside production', () => {
    const config = createServerConfig({
      NODE_ENV: 'development'
    });

    expect(config.sessionTokenSecret.length).toBeGreaterThan(20);
    expect(config.reconnectGraceMs).toBe(15_000);
  });

  it('allows overriding reconnect grace timeout through env', () => {
    const config = createServerConfig({
      RECONNECT_GRACE_MS: '9000'
    });

    expect(config.reconnectGraceMs).toBe(9000);
  });
});
