import type { BackendMetrics } from '../services/backend-metrics.js';

export type SocketTrafficEvent = 'signal' | 'chat' | 'policy';

export type RateLimitRule = {
  windowMs: number;
  maxEvents: number;
};

type CreateSocketTrafficControlOptions = {
  maxInFlight: number;
  rateLimits: Partial<Record<SocketTrafficEvent, RateLimitRule>>;
  metrics: BackendMetrics;
};

type EnterResult =
  | {
      ok: true;
      release: () => void;
    }
  | {
      ok: false;
      code: 'RATE_LIMITED' | 'BACKPRESSURE';
    };

export const createSocketTrafficControl = ({
  maxInFlight,
  rateLimits,
  metrics
}: CreateSocketTrafficControlOptions) => {
  const timestampsByEvent = new Map<SocketTrafficEvent, number[]>();
  let inFlight = 0;

  const isRateLimited = (event: SocketTrafficEvent, now: number) => {
    const rule = rateLimits[event];
    if (!rule) {
      return false;
    }

    const existing = timestampsByEvent.get(event) ?? [];
    const threshold = now - rule.windowMs;
    const fresh = existing.filter((timestamp) => timestamp >= threshold);
    timestampsByEvent.set(event, fresh);

    if (fresh.length >= rule.maxEvents) {
      return true;
    }

    fresh.push(now);
    return false;
  };

  return {
    enter(event: SocketTrafficEvent): EnterResult {
      if (inFlight >= maxInFlight) {
        metrics.increment('backpressureDrops');
        return {
          ok: false,
          code: 'BACKPRESSURE'
        };
      }

      const now = Date.now();
      if (isRateLimited(event, now)) {
        metrics.increment('rateLimitDrops');
        return {
          ok: false,
          code: 'RATE_LIMITED'
        };
      }

      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) {
            return;
          }

          released = true;
          inFlight = Math.max(0, inFlight - 1);
        }
      };
    }
  };
};

export type SocketTrafficControl = ReturnType<typeof createSocketTrafficControl>;
