export const WORLD_PROTOCOL_VERSION = 2;

export const MOVEMENT_SPEED = 220;
export const DETAILED_PLAYER_LIMIT = 50;
export const PRELOADED_PLAYER_LIMIT = 150;
export const MAX_INTEREST_PLAYERS = DETAILED_PLAYER_LIMIT + PRELOADED_PLAYER_LIMIT;

export type InterestZone = 1 | 2;

export interface WorldDescriptor {
  cityId: string;
  spaceId: string;
  width: number;
  height: number;
}

export interface NetworkPlayer {
  id: string;
  authUserId: string;
  slot: number;
  username: string;
  color: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  sequence: number;
  updatedAt: number;
  zone: InterestZone;
  circleId?: string;
  circleMode?: CircleMode;
  circleCount?: number;
  activity?: string;
}

export type CircleMode = "open" | "request" | "invite";
export type CircleGame = "cards" | "draw" | "bluff" | "square-off";
export type NearbyMediaType = "image" | "gif";

export interface CircleMember {
  playerId: string;
  authUserId: string;
  username: string;
  color: string;
  isHost: boolean;
  isMuted: boolean;
}

export interface CircleState {
  id: string;
  hostPlayerId: string;
  mode: CircleMode;
  members: CircleMember[];
  game: CircleGame | null;
  activity: string;
  revision: number;
  createdAt: number;
}

export interface RtcSessionDescriptionData {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface RtcIceCandidateData {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type CircleSignalData =
  | { description: RtcSessionDescriptionData }
  | { candidate: RtcIceCandidateData };

export interface CircleGameSnapshot {
  game: CircleGame;
  phase: string;
  revision: number;
  publicState: Record<string, unknown>;
  privateState?: Record<string, unknown>;
}

export interface HelloMessage {
  type: "hello";
  protocol: number;
  username: string;
  color: string;
  spawnX: number;
  spawnY: number;
}

export interface ProfileMessage {
  type: "profile";
  username: string;
  color: string;
}

export interface ChatMessage {
  type: "chat";
  text: string;
}

export interface PhotoGrantRequestMessage {
  type: "photo-grant";
  mediaType: NearbyMediaType;
}

export interface PhotoMessage {
  type: "photo";
  mediaId: string;
}

export interface PingMessage {
  type: "ping";
  sentAt: number;
}

export interface CircleInviteMessage {
  type: "circle-invite";
  targetPlayerId: string;
  mode: CircleMode;
}

export interface CircleInviteResponseMessage {
  type: "circle-invite-response";
  invitationId: string;
  accept: boolean;
}

export interface CircleJoinRequestMessage {
  type: "circle-join-request";
  circleId: string;
}

export interface CircleJoinResponseMessage {
  type: "circle-join-response";
  requesterPlayerId: string;
  accept: boolean;
}

export interface CircleLeaveMessage {
  type: "circle-leave";
}

export interface CircleModeMessage {
  type: "circle-mode";
  mode: CircleMode;
}

export interface CircleKickMessage {
  type: "circle-kick";
  targetPlayerId: string;
}

export interface CircleVoiceStateMessage {
  type: "circle-voice-state";
  muted: boolean;
}

export interface CircleSignalMessage {
  type: "circle-signal";
  targetPlayerId: string;
  signal: CircleSignalData;
}

export interface CircleGameStartMessage {
  type: "circle-game-start";
  game: CircleGame;
}

export interface CircleGameEndMessage {
  type: "circle-game-end";
}

export interface CircleGameActionMessage {
  type: "circle-game-action";
  action: string;
  payload?: unknown;
}

export type ClientControlMessage =
  | HelloMessage
  | ProfileMessage
  | ChatMessage
  | PhotoGrantRequestMessage
  | PhotoMessage
  | PingMessage
  | CircleInviteMessage
  | CircleInviteResponseMessage
  | CircleJoinRequestMessage
  | CircleJoinResponseMessage
  | CircleLeaveMessage
  | CircleModeMessage
  | CircleKickMessage
  | CircleVoiceStateMessage
  | CircleSignalMessage
  | CircleGameStartMessage
  | CircleGameEndMessage
  | CircleGameActionMessage;

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  playerId: string;
  slot: number;
  serverTime: number;
  onlineCount: number;
  world: WorldDescriptor;
}

export interface EnterMessage {
  type: "enter";
  player: NetworkPlayer;
}

export interface LeaveMessage {
  type: "leave";
  playerId: string;
  slot: number;
}

export interface ZoneMessage {
  type: "zone";
  slot: number;
  zone: InterestZone;
}

export interface CountMessage {
  type: "count";
  onlineCount: number;
}

export interface ServerChatMessage {
  type: "chat";
  id: string;
  player: NetworkPlayer;
  text: string;
  sentAt: number;
  durationMs: number;
}

export interface ServerPhotoMessage {
  type: "photo";
  id: string;
  player: NetworkPlayer;
  mediaId: string;
  mediaType: NearbyMediaType;
  downloadToken: string;
  sentAt: number;
  durationMs: number;
}

export interface PhotoGrantMessage {
  type: "photo-grant";
  mediaId: string;
  mediaType: NearbyMediaType;
  uploadToken: string;
  expiresAt: number;
}

export interface PongMessage {
  type: "pong";
  sentAt: number;
  serverTime: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface ServerCircleInviteMessage {
  type: "circle-invite";
  invitationId: string;
  fromPlayer: NetworkPlayer;
  circleId: string | null;
  mode: CircleMode;
  expiresAt: number;
}

export interface ServerCircleJoinRequestMessage {
  type: "circle-join-request";
  requester: NetworkPlayer;
  circleId: string;
}

export interface ServerCircleStateMessage {
  type: "circle-state";
  circle: CircleState;
}

export interface ServerCircleClosedMessage {
  type: "circle-closed";
  circleId: string;
  reason: string;
}

export interface ServerCircleSignalMessage {
  type: "circle-signal";
  fromPlayerId: string;
  signal: CircleSignalData;
}

export interface ServerCircleGameStateMessage {
  type: "circle-game-state";
  circleId: string;
  snapshot: CircleGameSnapshot;
}

export type ServerControlMessage =
  | WelcomeMessage
  | EnterMessage
  | LeaveMessage
  | ZoneMessage
  | CountMessage
  | ServerChatMessage
  | ServerPhotoMessage
  | PhotoGrantMessage
  | PongMessage
  | ErrorMessage
  | ServerCircleInviteMessage
  | ServerCircleJoinRequestMessage
  | ServerCircleStateMessage
  | ServerCircleClosedMessage
  | ServerCircleSignalMessage
  | ServerCircleGameStateMessage;

export const BinaryMessageKind = {
  MovementInput: 1,
  StateBatch: 2,
} as const;

export interface MovementInput {
  sequence: number;
  directionX: number;
  directionY: number;
  sentAtLow16: number;
}

export interface StateRecord {
  slot: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  sequence: number;
  zone: InterestZone;
}

const INPUT_BYTES = 8;
const STATE_HEADER_BYTES = 8;
const STATE_RECORD_BYTES = 14;

export function encodeMovementInput(input: MovementInput): ArrayBuffer {
  const buffer = new ArrayBuffer(INPUT_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryMessageKind.MovementInput);
  view.setUint8(1, WORLD_PROTOCOL_VERSION);
  view.setUint16(2, input.sequence & 0xffff, true);
  view.setInt8(4, quantizeDirection(input.directionX));
  view.setInt8(5, quantizeDirection(input.directionY));
  view.setUint16(6, input.sentAtLow16 & 0xffff, true);
  return buffer;
}

export function decodeMovementInput(buffer: ArrayBuffer): MovementInput | null {
  if (buffer.byteLength !== INPUT_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== BinaryMessageKind.MovementInput || view.getUint8(1) !== WORLD_PROTOCOL_VERSION) return null;
  return {
    sequence: view.getUint16(2, true),
    directionX: view.getInt8(4) / 127,
    directionY: view.getInt8(5) / 127,
    sentAtLow16: view.getUint16(6, true),
  };
}

export function encodeStateBatch(serverTime: number, records: StateRecord[]): ArrayBuffer {
  const count = Math.min(records.length, 0xffff);
  const buffer = new ArrayBuffer(STATE_HEADER_BYTES + count * STATE_RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryMessageKind.StateBatch);
  view.setUint8(1, WORLD_PROTOCOL_VERSION);
  view.setUint32(2, serverTime >>> 0, true);
  view.setUint16(6, count, true);

  for (let index = 0; index < count; index += 1) {
    const record = records[index];
    const offset = STATE_HEADER_BYTES + index * STATE_RECORD_BYTES;
    view.setUint16(offset, record.slot & 0xffff, true);
    view.setUint16(offset + 2, clampUint16(record.x), true);
    view.setUint16(offset + 4, clampUint16(record.y), true);
    view.setInt16(offset + 6, clampInt16(record.velocityX), true);
    view.setInt16(offset + 8, clampInt16(record.velocityY), true);
    view.setUint16(offset + 10, record.sequence & 0xffff, true);
    view.setUint8(offset + 12, record.zone);
    view.setUint8(offset + 13, 0);
  }

  return buffer;
}

export function decodeStateBatch(buffer: ArrayBuffer): { serverTime: number; records: StateRecord[] } | null {
  if (buffer.byteLength < STATE_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== BinaryMessageKind.StateBatch || view.getUint8(1) !== WORLD_PROTOCOL_VERSION) return null;
  const count = view.getUint16(6, true);
  if (buffer.byteLength !== STATE_HEADER_BYTES + count * STATE_RECORD_BYTES) return null;

  const records: StateRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = STATE_HEADER_BYTES + index * STATE_RECORD_BYTES;
    const zone = view.getUint8(offset + 12);
    if (zone !== 1 && zone !== 2) return null;
    records.push({
      slot: view.getUint16(offset, true),
      x: view.getUint16(offset + 2, true),
      y: view.getUint16(offset + 4, true),
      velocityX: view.getInt16(offset + 6, true),
      velocityY: view.getInt16(offset + 8, true),
      sequence: view.getUint16(offset + 10, true),
      zone,
    });
  }

  return { serverTime: view.getUint32(2, true), records };
}

export function normalizeDirection(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length < 0.001) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

function quantizeDirection(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(-1, Math.min(1, value)) * 127);
}

function clampUint16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(0xffff, value)));
}

function clampInt16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(-0x8000, Math.min(0x7fff, value)));
}
