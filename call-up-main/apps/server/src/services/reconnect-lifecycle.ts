import type { KeyValueStore } from '../storage/contracts.js';
import { createInMemoryKeyValueStore } from '../storage/in-memory.js';

export type ReconnectTimerStore = KeyValueStore<string, ReturnType<typeof setTimeout>>;

type CreateReconnectLifecycleOptions = {
  reconnectGraceMs: number;
  maxTimers?: number;
  onParticipantGraceExpired: (payload: {
    roomId: string;
    participantId: string;
    participantName: string;
  }) => Promise<void> | void;
  timerStore?: ReconnectTimerStore;
};

export const createReconnectLifecycle = ({
  reconnectGraceMs,
  maxTimers = 10_000,
  onParticipantGraceExpired,
  timerStore = createInMemoryKeyValueStore<string, ReturnType<typeof setTimeout>>()
}: CreateReconnectLifecycleOptions) => {
  const cancelParticipantRemoval = async (participantId: string) => {
    const timer = await timerStore.get(participantId);
    if (!timer) {
      return false;
    }

    clearTimeout(timer);
    await timerStore.delete(participantId);
    return true;
  };

  const scheduleParticipantRemoval = async (
    roomId: string,
    participantId: string,
    participantName: string
  ) => {
    const existingTimer = await timerStore.get(participantId);
    if (!existingTimer) {
      const timerCount = await timerStore.size();
      if (timerCount >= maxTimers) {
        return {
          ok: false as const,
          reason: 'MAX_TIMERS_REACHED' as const
        };
      }
    }

    await cancelParticipantRemoval(participantId);
    const timer = setTimeout(() => {
      void timerStore.delete(participantId);
      void onParticipantGraceExpired({
        roomId,
        participantId,
        participantName
      });
    }, reconnectGraceMs);

    await timerStore.set(participantId, timer);
    return {
      ok: true as const
    };
  };

  return {
    cancelParticipantRemoval,
    scheduleParticipantRemoval,
    async getScheduledCount() {
      return timerStore.size();
    }
  };
};

export type ReconnectLifecycle = ReturnType<typeof createReconnectLifecycle>;
