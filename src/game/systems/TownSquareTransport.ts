import type { InterestZone } from "../../../shared/worldProtocol";
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
}

export interface BlockChatMessage {
  id: string;
  player: OnlinePlayer;
  kind: "text" | "image";
  text: string;
  imageDataUrl?: string;
  objectPath?: string;
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
}

export interface TownSquareTransport {
  readonly connectionId: string;
  readonly mode: "world-socket" | "supabase-fallback";
  connect(profile: PlayerIdentity, x: number, y: number): Promise<string>;
  updatePresence(profile: PlayerIdentity, x: number, y: number): void;
  sendMovement(profile: PlayerIdentity, x: number, y: number, directionX: number, directionY: number): void;
  sendChat(profile: PlayerIdentity, text: string, x: number, y: number): BlockChatMessage | null;
  sendImage(profile: PlayerIdentity, imageDataUrl: string, x: number, y: number): Promise<BlockChatMessage | null>;
  disconnect(): Promise<void>;
}
