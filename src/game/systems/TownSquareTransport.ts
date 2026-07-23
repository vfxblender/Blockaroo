import type {
  CircleGame,
  CircleGameSnapshot,
  CircleMode,
  CircleSignalData,
  CircleState,
  InterestZone,
  ServerCircleInviteMessage,
  ServerCircleJoinRequestMessage,
} from "../../../shared/worldProtocol";
import type { PlayerIdentity } from "../types/world";

export type ConnectionStatus = "connecting" | "online" | "offline" | "error";

export interface OnlinePlayer extends PlayerIdentity {
  authUserId: string;
  slot: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  sequence: number;
  zone: InterestZone;
  updatedAt: number;
  circleId?: string;
  circleMode?: CircleMode;
  circleCount?: number;
  activity?: string;
}

export interface BlockChatMessage {
  id: string;
  player: OnlinePlayer;
  kind: "text" | "image";
  text: string;
  imageDataUrl?: string;
  mediaId?: string;
  sentAt: number;
  durationMs: number;
}

export interface TownSquareCallbacks {
  onPlayers(players: OnlinePlayer[]): void;
  onMovement(player: OnlinePlayer): void;
  onCorrection(x: number, y: number, velocityX: number, velocityY: number, sequence: number): void;
  onChat(message: BlockChatMessage): void;
  onCount(count: number): void;
  onStatus(status: ConnectionStatus): void;
  onNotice(message: string): void;
  shouldReceiveFrom(authUserId: string): boolean;
  onCircleInvite(message: ServerCircleInviteMessage): void;
  onCircleJoinRequest(message: ServerCircleJoinRequestMessage): void;
  onCircleState(circle: CircleState): void;
  onCircleClosed(circleId: string, reason: string): void;
  onCircleSignal(fromPlayerId: string, signal: CircleSignalData): void;
  onCircleGameState(circleId: string, snapshot: CircleGameSnapshot): void;
}

export interface TownSquareTransport {
  readonly connectionId: string;
  readonly mode: "world-socket" | "supabase-fallback";
  readonly supportsCircles: boolean;
  connect(profile: PlayerIdentity, x: number, y: number): Promise<string>;
  updatePresence(profile: PlayerIdentity, x: number, y: number): void;
  sendMovement(profile: PlayerIdentity, x: number, y: number, directionX: number, directionY: number): void;
  sendChat(profile: PlayerIdentity, text: string, x: number, y: number): BlockChatMessage | null;
  sendImage(profile: PlayerIdentity, imageDataUrl: string, x: number, y: number): Promise<BlockChatMessage | null>;
  inviteToCircle(targetPlayerId: string, mode: CircleMode): void;
  respondToCircleInvite(invitationId: string, accept: boolean): void;
  requestToJoinCircle(circleId: string): void;
  respondToCircleRequest(requesterPlayerId: string, accept: boolean): void;
  leaveCircle(): void;
  setCircleMode(mode: CircleMode): void;
  kickFromCircle(targetPlayerId: string): void;
  setCircleVoiceMuted(muted: boolean): void;
  sendCircleSignal(targetPlayerId: string, signal: CircleSignalData): void;
  startCircleGame(game: CircleGame): void;
  endCircleGame(): void;
  sendCircleGameAction(action: string, payload?: unknown): void;
  disconnect(): Promise<void>;
}
