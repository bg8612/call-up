import { randomBytes } from 'node:crypto';

type ServerEnv = NodeJS.ProcessEnv;

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const createServerConfig = (env: ServerEnv = process.env) => {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const sessionTokenSecret = env.SESSION_TOKEN_SECRET?.trim();

  if (isProduction && !sessionTokenSecret) {
    throw new Error(
      'SESSION_TOKEN_SECRET must be explicitly set in production and shared across all backend instances'
    );
  }

  return {
    nodeEnv,
    isProduction,
    reconnectGraceMs: 60_000,
    sessionTokenTtlMs: 7 * 24 * 60 * 60 * 1000,
    serverInstanceId: env.SERVER_INSTANCE_ID?.trim() || 'local-instance',
    sessionTokenSecret: sessionTokenSecret || randomBytes(32).toString('hex'),
    chatHistoryLimit: parseNumber(env.CHAT_HISTORY_LIMIT, 200),
    emptyRoomSweepIntervalMs: parseNumber(env.EMPTY_ROOM_SWEEP_INTERVAL_MS, 30_000),
    maxReconnectTimers: parseNumber(env.MAX_RECONNECT_TIMERS, 10_000),
    signalMaxBytes: parseNumber(env.SIGNAL_MAX_BYTES, 65_536),
    signalRateLimitPer10s: parseNumber(env.RL_SIGNAL_PER_10S, 120),
    chatRateLimitPer10s: parseNumber(env.RL_CHAT_PER_10S, 20),
    policyRateLimitPerMin: parseNumber(env.RL_POLICY_PER_MIN, 10),
    maxInflightEventsPerSocket: parseNumber(env.MAX_INFLIGHT_EVENTS_PER_SOCKET, 32),
    healthMemoryRssDegradedBytes: parseNumber(env.HEALTH_MEMORY_RSS_DEGRADED_BYTES, 512 * 1024 * 1024),
    healthSignalFailuresDegradedAt: parseNumber(env.HEALTH_SIGNALING_FAILURES_DEGRADED_AT, 1),
    healthRateLimitDropsDegradedAt: parseNumber(env.HEALTH_RATE_LIMIT_DROPS_DEGRADED_AT, 1),
    healthBackpressureDropsDegradedAt: parseNumber(env.HEALTH_BACKPRESSURE_DROPS_DEGRADED_AT, 1),
    healthDeliveryFailuresDegradedAt: parseNumber(env.HEALTH_DELIVERY_FAILURES_DEGRADED_AT, 1),
    healthPolicyViolationsDegradedAt: parseNumber(env.HEALTH_POLICY_VIOLATIONS_DEGRADED_AT, 10)
  };
};

export type ServerConfig = ReturnType<typeof createServerConfig>;
