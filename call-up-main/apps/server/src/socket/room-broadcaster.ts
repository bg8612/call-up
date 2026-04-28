export type RoomBroadcaster = {
  emitToRoom(roomId: string, event: string, payload: unknown): Promise<void>;
  emitToRoomExcept(
    roomId: string,
    excludedSocketId: string,
    event: string,
    payload: unknown
  ): Promise<void>;
};
