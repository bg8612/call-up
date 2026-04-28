export type BackendMetricCounter =
  | 'reconnectAttempts'
  | 'signalingFailures'
  | 'deliveryFailures'
  | 'policyViolations'
  | 'chatEvents'
  | 'rateLimitDrops'
  | 'backpressureDrops'
  | 'policyEnforcements';

type CounterSnapshot = Record<BackendMetricCounter, number>;

const createInitialCounters = (): CounterSnapshot => ({
  reconnectAttempts: 0,
  signalingFailures: 0,
  deliveryFailures: 0,
  policyViolations: 0,
  chatEvents: 0,
  rateLimitDrops: 0,
  backpressureDrops: 0,
  policyEnforcements: 0
});

export const createBackendMetrics = () => {
  const counters: CounterSnapshot = createInitialCounters();

  return {
    increment(counter: BackendMetricCounter, by = 1) {
      counters[counter] += by;
    },
    snapshot() {
      return {
        ...counters
      };
    }
  };
};

export type BackendMetrics = ReturnType<typeof createBackendMetrics>;
