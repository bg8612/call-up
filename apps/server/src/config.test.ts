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
  });
});
