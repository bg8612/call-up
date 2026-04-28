import type { ChatMessage, Participant, RoomPolicy, WireParticipant } from './types';

export type CallState = {
  participants: Participant[];
  chatMessages: ChatMessage[];
  policy: RoomPolicy;
};

export type CallAction =
  | { type: 'session/reset' }
  | { type: 'participants/synced'; participants: Array<Participant | WireParticipant> }
  | { type: 'participants/upserted'; participant: Participant | WireParticipant }
  | { type: 'participants/removed'; participantId: string }
  | { type: 'participants/pinned'; participantId: string | null }
  | { type: 'participants/speakingChanged'; participantId: string; isSpeaking: boolean }
  | { type: 'chat/messageReceived'; message: ChatMessage }
  | { type: 'room/policySynced'; policy: RoomPolicy };

export const createInitialCallState = (): CallState => ({
  participants: [],
  chatMessages: [],
  policy: {
    allowChat: true,
    allowScreenShare: true,
    allowSystemAudio: true
  }
});

const sortParticipants = (participants: Participant[]) =>
  [...participants].sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === 'owner' ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });

const normalizeParticipant = (
  participant: Participant | WireParticipant,
  previous?: Participant
): Participant => ({
  ...participant,
  isSpeaking: 'isSpeaking' in participant ? participant.isSpeaking : previous?.isSpeaking ?? false
});

export const reduceCallState = (state: CallState, action: CallAction): CallState => {
  switch (action.type) {
    case 'session/reset':
      return createInitialCallState();
    case 'participants/synced':
      return {
        ...state,
        participants: sortParticipants(
          action.participants.map((participant) =>
            normalizeParticipant(
              participant,
              state.participants.find((current) => current.id === participant.id)
            )
          )
        )
      };
    case 'participants/upserted': {
      const existing = state.participants.find((participant) => participant.id === action.participant.id);
      const normalized = normalizeParticipant(action.participant, existing);
      const participants = existing
        ? state.participants.map((participant) =>
            participant.id === action.participant.id ? normalized : participant
          )
        : [...state.participants, normalized];

      return {
        ...state,
        participants: sortParticipants(participants)
      };
    }
    case 'participants/removed':
      return {
        ...state,
        participants: state.participants.filter((participant) => participant.id !== action.participantId)
      };
    case 'participants/pinned':
      return {
        ...state,
        participants: state.participants.map((participant) => ({
          ...participant,
          isPinned: action.participantId === null ? false : participant.id === action.participantId
        }))
      };
    case 'participants/speakingChanged':
      return {
        ...state,
        participants: state.participants.map((participant) =>
          participant.id === action.participantId ? { ...participant, isSpeaking: action.isSpeaking } : participant
        )
      };
    case 'chat/messageReceived':
      return {
        ...state,
        chatMessages: [...state.chatMessages, action.message]
      };
    case 'room/policySynced':
      return {
        ...state,
        policy: action.policy
      };
    default:
      return state;
  }
};
