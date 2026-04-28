import { createHmac, timingSafeEqual } from 'node:crypto';

type ParticipantSessionTokenPayload = {
  v: 1;
  roomId: string;
  participantId: string;
  iat: number;
  exp: number;
};

type CreateParticipantSessionTokenServiceOptions = {
  secret: string;
  ttlMs: number;
};

const toBase64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const createSignature = (secret: string, payloadB64: string) =>
  createHmac('sha256', secret).update(payloadB64).digest();

export const createParticipantSessionTokenService = ({
  secret,
  ttlMs
}: CreateParticipantSessionTokenServiceOptions) => {
  const issue = (payload: { roomId: string; participantId: string }) => {
    const now = Date.now();
    const tokenPayload: ParticipantSessionTokenPayload = {
      v: 1,
      roomId: payload.roomId,
      participantId: payload.participantId,
      iat: now,
      exp: now + ttlMs
    };

    const encodedPayload = toBase64Url(JSON.stringify(tokenPayload));
    const signature = createSignature(secret, encodedPayload).toString('base64url');
    return `${encodedPayload}.${signature}`;
  };

  const verify = (token: string | undefined) => {
    if (!token) {
      return undefined;
    }

    const [encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedPayload || !encodedSignature || extra) {
      return undefined;
    }

    let payload: ParticipantSessionTokenPayload;
    try {
      payload = JSON.parse(fromBase64Url(encodedPayload)) as ParticipantSessionTokenPayload;
    } catch {
      return undefined;
    }

    if (
      payload.v !== 1 ||
      typeof payload.roomId !== 'string' ||
      typeof payload.participantId !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      return undefined;
    }

    if (payload.exp < Date.now()) {
      return undefined;
    }

    const expectedSignature = createSignature(secret, encodedPayload);
    const providedSignature = Buffer.from(encodedSignature, 'base64url');
    if (providedSignature.length !== expectedSignature.length) {
      return undefined;
    }

    if (!timingSafeEqual(providedSignature, expectedSignature)) {
      return undefined;
    }

    return {
      roomId: payload.roomId,
      participantId: payload.participantId
    };
  };

  return {
    issue,
    verify
  };
};

export type ParticipantSessionTokenService = ReturnType<typeof createParticipantSessionTokenService>;
