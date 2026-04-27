import type { SignalPayload } from './protocol.js';

export type SignalingDeliveryResult =
  | { delivered: true }
  | {
      delivered: false;
      reason: 'TARGET_NOT_CONNECTED' | 'REMOTE_INSTANCE_UNSUPPORTED';
    };

export type SignalingDelivery = {
  deliverSignal(
    targetParticipantId: string,
    payload: {
      fromParticipantId: string;
      signal: SignalPayload['signal'];
    }
  ): Promise<SignalingDeliveryResult>;
};
