import { z } from 'zod';
import type { ChatMessage, ParticipantSnapshot, RoomPolicy } from '../domain/room-state.js';

export const joinRoomSchema = z.object({
  roomId: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(48),
  clientSessionId: z.string().trim().min(8).max(2048).optional(),
  sessionToken: z.string().trim().min(8).max(2048).optional()
});

export const signalSchema = z.object({
  targetParticipantId: z.string(),
  signal: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('offer'),
      payload: z.object({
        type: z.literal('offer').optional(),
        sdp: z.string().min(1).max(32_768)
      })
    }),
    z.object({
      type: z.literal('answer'),
      payload: z.object({
        type: z.literal('answer').optional(),
        sdp: z.string().min(1).max(32_768)
      })
    }),
    z.object({
      type: z.literal('candidate'),
      payload: z.object({
        candidate: z.string().min(1).max(8_192),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(256).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional()
      })
    })
  ])
});

export const mediaStateSchema = z.object({
  isCameraOn: z.boolean().optional(),
  isMicOn: z.boolean().optional(),
  isSpeaking: z.boolean().optional(),
  isScreenSharing: z.boolean().optional(),
  isSharingAudio: z.boolean().optional(),
  cameraStreamId: z.string().optional(),
  screenStreamId: z.string().optional()
});

export const speakingStateSchema = z.object({
  isSpeaking: z.boolean()
});

export const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(500)
});

export const policySchema = z.object({
  allowChat: z.boolean().optional(),
  allowScreenShare: z.boolean().optional(),
  allowSystemAudio: z.boolean().optional()
});

export type JoinAck =
  | {
      ok: true;
      participantId: string;
      clientSessionId: string;
      sessionToken: string;
      roomId: string;
      participants: ParticipantSnapshot[];
      chatMessages: ChatMessage[];
      policy: RoomPolicy;
    }
  | { ok: false; error: string };

export type MediaStateAck =
  | {
      ok: true;
      participant: ParticipantSnapshot;
    }
  | { ok: false; error: string };

export type SignalPayload = z.infer<typeof signalSchema>;
