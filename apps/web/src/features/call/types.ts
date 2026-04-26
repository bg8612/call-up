export type ParticipantRole = 'owner' | 'participant';

export type ConnectionState = 'connected' | 'reconnecting';

export type Participant = {
  id: string;
  displayName: string;
  role: ParticipantRole;
  isCameraOn: boolean;
  isMicOn: boolean;
  isSpeaking: boolean;
  isScreenSharing: boolean;
  isSharingAudio: boolean;
  isPinned: boolean;
  connectionState: ConnectionState;
  cameraStreamId?: string;
  screenStreamId?: string;
};

export type WireParticipant = Omit<Participant, 'isSpeaking'>;

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  kind: 'user' | 'system';
  createdAt: number;
};

export type RoomPolicy = {
  allowChat: boolean;
  allowScreenShare: boolean;
  allowSystemAudio: boolean;
};

export type DeviceLists = {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
};

export type RemoteMediaState = {
  cameraStream?: MediaStream;
  screenStream?: MediaStream;
};

export type AudioOutputMediaElement = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};
