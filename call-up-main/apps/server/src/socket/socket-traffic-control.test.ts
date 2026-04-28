import { describe, expect, it } from 'vitest';
import { createBackendMetrics } from '../services/backend-metrics.js';
import { createSocketTrafficControl } from './socket-traffic-control.js';

describe('createSocketTrafficControl', () => {
  it('rate limits events within configured window', () => {
    const metrics = createBackendMetrics();
    const control = createSocketTrafficControl({
      maxInFlight: 10,
      rateLimits: {
        chat: {
          windowMs: 1_000,
          maxEvents: 2
        }
      },
      metrics
    });

    const first = control.enter('chat');
    const second = control.enter('chat');
    const third = control.enter('chat');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({
      ok: false,
      code: 'RATE_LIMITED'
    });
    expect(metrics.snapshot().rateLimitDrops).toBe(1);

    if (first.ok) {
      first.release();
    }
    if (second.ok) {
      second.release();
    }
  });

  it('applies backpressure when in-flight limit is reached', () => {
    const metrics = createBackendMetrics();
    const control = createSocketTrafficControl({
      maxInFlight: 1,
      rateLimits: {},
      metrics
    });

    const first = control.enter('signal');
    const second = control.enter('signal');

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      code: 'BACKPRESSURE'
    });
    expect(metrics.snapshot().backpressureDrops).toBe(1);

    if (first.ok) {
      first.release();
    }
  });
});
