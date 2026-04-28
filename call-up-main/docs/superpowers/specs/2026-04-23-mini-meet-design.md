# Mini Meet MVP Design

## Goal

Build a browser-based application that supports:

- multi-user audio and video calls;
- in-call text chat;
- screen sharing by any permitted participant;
- optional system audio sharing when supported by the browser;
- room roles, permissions, and basic media controls;
- frontend and backend inside one project folder.

## Architecture

- `apps/web`: React + TypeScript + Vite SPA.
- `apps/server`: Node.js + TypeScript + Express + Socket.IO backend.
- Realtime media: browser WebRTC in mesh mode for MVP.
- Realtime events: Socket.IO for signaling, room presence, permissions, and chat.

## MVP Scope

- Room join by room code and display name.
- Multi-user audio/video call in a single room.
- In-call chat with system events.
- Camera, microphone, and speaker controls.
- Screen share with optional system audio track support.
- Moderator-like permissions for the room creator.
- Responsive UI for desktop and tablet/mobile.

## Deliberate Tradeoffs

- MVP uses WebRTC mesh instead of SFU to keep the code self-contained.
- Recommended room size is small-group usage.
- Persistence is in-memory on the server for the first version.
- Designed so signaling and room state can later be swapped to Redis/Postgres and SFU.

## Backend Responsibilities

- Track rooms, participants, roles, and media permissions.
- Relay WebRTC signaling messages between peers.
- Broadcast chat messages and room state updates.
- Handle join, leave, mute-state, camera-state, and screen-share-state events.

## Frontend Responsibilities

- Manage local media devices and permissions.
- Create peer connections for each remote participant.
- Publish local camera/mic/screen tracks and renegotiate when they change.
- Show participant grid, active call controls, chat panel, and settings drawer.

## Verification Target

- `npm test`
- `npm run build`
- manual smoke test with two browser tabs joining the same room
