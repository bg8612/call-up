import type { Server } from 'socket.io';
import type { RoomBroadcaster } from './room-broadcaster.js';

type CreateLocalRoomBroadcasterOptions = {
  io: Server;
};

// This broadcaster emits only to sockets on the current process.
// Cross-instance room fanout still requires a shared Socket.IO adapter such as Redis.
export const createLocalRoomBroadcaster = ({
  io
}: CreateLocalRoomBroadcasterOptions): RoomBroadcaster => ({
  async emitToRoom(roomId, event, payload) {
    io.to(roomId).emit(event, payload);
  },
  async emitToRoomExcept(roomId, excludedSocketId, event, payload) {
    io.to(roomId).except(excludedSocketId).emit(event, payload);
  }
});
