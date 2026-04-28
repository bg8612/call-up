import { describe, expect, it } from 'vitest';
import { signalSchema, speakingStateSchema } from './protocol.js';

describe('signalSchema', () => {
  it('accepts valid offer/answer/candidate payloads', () => {
    expect(
      signalSchema.safeParse({
        targetParticipantId: 'p_1',
        signal: {
          type: 'offer',
          payload: {
            type: 'offer',
            sdp: 'v=0'
          }
        }
      }).success
    ).toBe(true);

    expect(
      signalSchema.safeParse({
        targetParticipantId: 'p_2',
        signal: {
          type: 'candidate',
          payload: {
            candidate: 'candidate:1 1 udp 2122252543 192.168.0.2 54400 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0
          }
        }
      }).success
    ).toBe(true);
  });

  it('preserves SDP payloads without trimming protocol line endings', () => {
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ssrc:1 msid:stream track\r\n';
    const parsed = signalSchema.parse({
      targetParticipantId: 'p_1',
      signal: {
        type: 'offer',
        payload: {
          type: 'offer',
          sdp
        }
      }
    });

    expect(parsed.signal.payload.sdp).toBe(sdp);
    expect(parsed.signal.payload.sdp.endsWith('\r\n')).toBe(true);
  });

  it('rejects malformed signaling payloads', () => {
    expect(
      signalSchema.safeParse({
        targetParticipantId: 'p_1',
        signal: {
          type: 'offer',
          payload: {}
        }
      }).success
    ).toBe(false);

    expect(
      signalSchema.safeParse({
        targetParticipantId: 'p_2',
        signal: {
          type: 'candidate',
          payload: {
            candidate: ''
          }
        }
      }).success
    ).toBe(false);
  });
});

describe('speakingStateSchema', () => {
  it('accepts only boolean speaking state payloads', () => {
    expect(speakingStateSchema.safeParse({ isSpeaking: true }).success).toBe(true);
    expect(speakingStateSchema.safeParse({ isSpeaking: false }).success).toBe(true);
    expect(speakingStateSchema.safeParse({ isSpeaking: 'yes' }).success).toBe(false);
  });
});
