import {
  WORLD_PROTOCOL_VERSION,
  decodeStateBatch,
  encodeMovementInput,
  normalizeDirection,
  type CircleGame,
  type CircleMode,
  type CircleSignalData,
  type NearbyMediaType,
  type NetworkPlayer,
  type PhotoGrantMessage,
  type ServerControlMessage,
} from "../../../shared/worldProtocol";
import { WORLD } from "../config";
import type { PlayerIdentity } from "../types/world";
import { getOrCreateAnonymousSession } from "../../services/supabase";
import { CloudflarePhotoStore } from "../../services/CloudflarePhotoStore";
import { ServerClock } from "./ServerClock";
import type {
  BlockChatMessage,
  OnlinePlayer,
  TownSquareCallbacks,
  TownSquareTransport,
} from "./TownSquareTransport";

interface SessionTicketResponse {
  ticket?: string;
  error?: string;
}

interface PendingPhotoGrant {
  resolve(grant: PhotoGrantMessage): void;
  reject(error: Error): void;
  timeout: number;
}

const MOVEMENT_HEARTBEAT_MS = 3_000;
const ROOM_RECONCILE_MS = 15_000;
const CONNECT_TIMEOUT_MS = 12_000;
const PHOTO_GRANT_TIMEOUT_MS = 8_000;

export class WebSocketTownSquare implements TownSquareTransport {
  readonly mode = "world-socket" as const;
  readonly supportsCircles = true;
  private socket: WebSocket | null = null;
  private _connectionId = "";
  private authUserId = "";
  private localSlot = 0;
  private generation = 0;
  private sequence = 0;
  private lastDirectionX = 0;
  private lastDirectionY = 0;
  private lastMovementAt = 0;
  private lastPingAt = 0;
  private playersBySlot = new Map<number, OnlinePlayer>();
  private readonly photos: CloudflarePhotoStore;
  private readonly serverClock = new ServerClock();
  private pendingPhotoGrant: PendingPhotoGrant | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly callbacks: TownSquareCallbacks,
  ) {
    this.photos = new CloudflarePhotoStore(endpoint);
  }

  get connectionId(): string {
    return this._connectionId || this.authUserId;
  }

  async connect(profile: PlayerIdentity, x: number, y: number): Promise<string> {
    const generation = ++this.generation;
    this.rejectPendingPhotoGrant(new Error("The world connection restarted."));
    await this.closeSocket();
    this.callbacks.onStatus("connecting");
    this.playersBySlot.clear();
    this.callbacks.onPlayers([]);
    this.localSlot = 0;
    this.sequence = 0;
    this.lastDirectionX = 0;
    this.lastDirectionY = 0;
    this.lastMovementAt = 0;
    this.lastPingAt = 0;
    this.serverClock.reset();

    const session = await getOrCreateAnonymousSession();
    if (generation !== this.generation) return this.connectionId;
    this.authUserId = session.user.id;
    const ticket = await this.requestTicket(session.access_token);
    if (generation !== this.generation) return this.connectionId;

    const socketUrl = new URL(`${this.endpoint.replace(/\/$/, "")}/world/${WORLD.cityId}/${WORLD.spaceId}`);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", ticket);
    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled || generation !== this.generation) return;
        settled = true;
        socket.close(4000, "Connection timed out");
        reject(new Error("The Blockaroo world server did not answer in time."));
      }, CONNECT_TIMEOUT_MS);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      };

      socket.addEventListener("open", () => {
        if (generation !== this.generation) return socket.close();
        socket.send(JSON.stringify({
          type: "hello",
          protocol: WORLD_PROTOCOL_VERSION,
          username: profile.username,
          color: profile.color,
          spawnX: x,
          spawnY: y,
        }));
      });
      socket.addEventListener("message", event => {
        if (generation !== this.generation) return;
        if (event.data instanceof ArrayBuffer) {
          this.handleStateBatch(event.data);
          return;
        }
        if (typeof event.data !== "string") return;
        let message: ServerControlMessage;
        try {
          message = JSON.parse(event.data) as ServerControlMessage;
        } catch {
          return;
        }
        if (message.type === "welcome" && !settled) {
          const receivedAt = Date.now();
          this.serverClock.observeWelcome(message.serverTime, receivedAt);
          settled = true;
          window.clearTimeout(timeout);
          this._connectionId = message.playerId;
          this.localSlot = message.slot;
          this.lastMovementAt = 0;
          this.sendPing(receivedAt);
          this.callbacks.onCount(message.onlineCount);
          this.callbacks.onStatus("online");
          resolve(message.playerId);
        }
        void this.handleControl(message);
      });
      socket.addEventListener("error", () => {
        this.callbacks.onStatus("error");
        fail(new Error("The Blockaroo world WebSocket could not connect."));
      });
      socket.addEventListener("close", event => {
        if (generation !== this.generation) return;
        this.rejectPendingPhotoGrant(new Error(event.reason || "The world connection closed during the photo upload."));
        if (!settled) fail(new Error(event.reason || "The Blockaroo world WebSocket closed before joining."));
        this.callbacks.onStatus(event.code === 1000 ? "offline" : "error");
      });
    });
  }

  updatePresence(profile: PlayerIdentity, _x: number, _y: number): void {
    this.sendJson({ type: "profile", username: profile.username, color: profile.color });
  }

  sendMovement(_profile: PlayerIdentity, _x: number, _y: number, rawDirectionX: number, rawDirectionY: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.localSlot) return;

    const now = Date.now();
    const direction = normalizeDirection(rawDirectionX, rawDirectionY);
    const changed = Math.abs(direction.x - this.lastDirectionX) > 0.025 || Math.abs(direction.y - this.lastDirectionY) > 0.025;
    const moving = direction.x !== 0 || direction.y !== 0;
    if (changed || (moving && now - this.lastMovementAt >= MOVEMENT_HEARTBEAT_MS)) {
      this.sequence = (this.sequence + 1) & 0xffff;
      this.socket.send(encodeMovementInput({
        sequence: this.sequence,
        directionX: direction.x,
        directionY: direction.y,
        sentAtLow16: Math.round(this.serverClock.toServerTime(now)) & 0xffff,
      }));
      this.lastDirectionX = direction.x;
      this.lastDirectionY = direction.y;
      this.lastMovementAt = now;
    }
    if (now - this.lastPingAt >= ROOM_RECONCILE_MS) {
      this.sendPing(now);
    }
  }

  sendChat(profile: PlayerIdentity, text: string, x: number, y: number): BlockChatMessage | null {
    if (this.socket?.readyState !== WebSocket.OPEN) return null;
    const cleanText = text.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!cleanText) return null;
    this.sendJson({ type: "chat", text: cleanText });
    return {
      id: crypto.randomUUID(),
      player: this.localPlayer(profile, x, y),
      kind: "text",
      text: cleanText,
      sentAt: Date.now(),
      durationMs: 12_000,
    };
  }

  async sendImage(profile: PlayerIdentity, imageDataUrl: string, x: number, y: number): Promise<BlockChatMessage | null> {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authUserId) return null;
    const mediaType: NearbyMediaType = imageDataUrl.startsWith("data:image/gif;base64,") ? "gif" : "image";
    const grant = await this.requestPhotoGrant(mediaType);
    await this.photos.upload(grant, imageDataUrl);
    this.sendJson({ type: "photo", mediaId: grant.mediaId });
    return {
      id: crypto.randomUUID(),
      player: this.localPlayer(profile, x, y),
      kind: "image",
      text: "",
      imageDataUrl,
      mediaId: grant.mediaId,
      sentAt: Date.now(),
      durationMs: 12_000,
    };
  }

  inviteToCircle(targetPlayerId: string, mode: CircleMode): void {
    this.sendJson({ type: "circle-invite", targetPlayerId, mode });
  }

  respondToCircleInvite(invitationId: string, accept: boolean): void {
    this.sendJson({ type: "circle-invite-response", invitationId, accept });
  }

  requestToJoinCircle(circleId: string): void {
    this.sendJson({ type: "circle-join-request", circleId });
  }

  respondToCircleRequest(requesterPlayerId: string, accept: boolean): void {
    this.sendJson({ type: "circle-join-response", requesterPlayerId, accept });
  }

  leaveCircle(): void {
    this.sendJson({ type: "circle-leave" });
  }

  setCircleMode(mode: CircleMode): void {
    this.sendJson({ type: "circle-mode", mode });
  }

  kickFromCircle(targetPlayerId: string): void {
    this.sendJson({ type: "circle-kick", targetPlayerId });
  }

  setCircleVoiceMuted(muted: boolean): void {
    this.sendJson({ type: "circle-voice-state", muted });
  }

  sendCircleSignal(targetPlayerId: string, signal: CircleSignalData): void {
    this.sendJson({ type: "circle-signal", targetPlayerId, signal });
  }

  startCircleGame(game: CircleGame): void {
    this.sendJson({ type: "circle-game-start", game });
  }

  endCircleGame(): void {
    this.sendJson({ type: "circle-game-end" });
  }

  sendCircleGameAction(action: string, payload?: unknown): void {
    this.sendJson({ type: "circle-game-action", action, payload });
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    this.rejectPendingPhotoGrant(new Error("The world connection closed."));
    await this.closeSocket();
  }

  private async requestTicket(accessToken: string): Promise<string> {
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cityId: WORLD.cityId, spaceId: WORLD.spaceId }),
    });
    const result = await response.json() as SessionTicketResponse;
    if (!response.ok || !result.ticket) throw new Error(result.error || "The world server rejected the Supabase session.");
    return result.ticket;
  }

  private async handleControl(message: ServerControlMessage): Promise<void> {
    if (message.type === "photo-grant") {
      const pending = this.pendingPhotoGrant;
      if (!pending) return;
      this.pendingPhotoGrant = null;
      window.clearTimeout(pending.timeout);
      pending.resolve(message);
      return;
    }
    if (message.type === "enter") {
      const player = this.toOnlinePlayer(message.player);
      if (player.slot === this.localSlot) return;
      this.playersBySlot.set(player.slot, player);
      this.callbacks.onMovement(player);
      return;
    }
    if (message.type === "leave") {
      this.playersBySlot.delete(message.slot);
      this.callbacks.onPlayers([...this.playersBySlot.values()]);
      return;
    }
    if (message.type === "zone") {
      const player = this.playersBySlot.get(message.slot);
      if (player) {
        player.zone = message.zone;
        player.updatedAt = Date.now();
        this.callbacks.onMovement({ ...player });
      }
      return;
    }
    if (message.type === "count") {
      this.callbacks.onCount(message.onlineCount);
      return;
    }
    if (message.type === "pong") {
      this.serverClock.observePong(message.sentAt, message.serverTime);
      return;
    }
    if (message.type === "chat") {
      if (message.player.id === this.connectionId) return;
      if (!this.callbacks.shouldReceiveFrom(message.player.authUserId)) return;
      const player = this.toOnlinePlayer(message.player);
      this.playersBySlot.set(player.slot, player);
      this.callbacks.onChat({
        id: message.id,
        player,
        kind: "text",
        text: message.text,
        sentAt: this.serverClock.toLocalTime(message.sentAt),
        durationMs: message.durationMs,
      });
      return;
    }
    if (message.type === "photo") {
      if (message.player.id === this.connectionId) return;
      if (!this.callbacks.shouldReceiveFrom(message.player.authUserId)) return;
      try {
        const imageDataUrl = await this.photos.download(message.mediaId, message.mediaType, message.downloadToken);
        const player = this.toOnlinePlayer(message.player);
        this.playersBySlot.set(player.slot, player);
        this.callbacks.onChat({
          id: message.id,
          player,
          kind: "image",
          text: "",
          imageDataUrl,
          mediaId: message.mediaId,
          sentAt: this.serverClock.toLocalTime(message.sentAt),
          durationMs: message.durationMs,
        });
      } catch (error) {
        console.warn("Blockaroo could not open a nearby temporary picture", error);
      }
      return;
    }
    if (message.type === "circle-invite") {
      this.callbacks.onCircleInvite(message);
      return;
    }
    if (message.type === "circle-join-request") {
      this.callbacks.onCircleJoinRequest(message);
      return;
    }
    if (message.type === "circle-state") {
      this.callbacks.onCircleState(message.circle);
      return;
    }
    if (message.type === "circle-closed") {
      this.callbacks.onCircleClosed(message.circleId, message.reason);
      return;
    }
    if (message.type === "circle-signal") {
      this.callbacks.onCircleSignal(message.fromPlayerId, message.signal);
      return;
    }
    if (message.type === "circle-game-state") {
      this.callbacks.onCircleGameState(message.circleId, message.snapshot);
      return;
    }
    if (message.type === "error") {
      if (message.code.startsWith("photo_")) this.rejectPendingPhotoGrant(new Error(message.message));
      this.callbacks.onNotice(message.message);
    }
  }

  private requestPhotoGrant(mediaType: NearbyMediaType): Promise<PhotoGrantMessage> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The world socket is not connected."));
    }
    if (this.pendingPhotoGrant) {
      return Promise.reject(new Error("A temporary picture is already being prepared."));
    }

    return new Promise<PhotoGrantMessage>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!this.pendingPhotoGrant) return;
        this.pendingPhotoGrant = null;
        reject(new Error("The temporary photo upload permission timed out."));
      }, PHOTO_GRANT_TIMEOUT_MS);
      this.pendingPhotoGrant = { resolve, reject, timeout };
      this.sendJson({ type: "photo-grant", mediaType });
    });
  }

  private rejectPendingPhotoGrant(error: Error): void {
    const pending = this.pendingPhotoGrant;
    if (!pending) return;
    this.pendingPhotoGrant = null;
    window.clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private handleStateBatch(buffer: ArrayBuffer): void {
    const batch = decodeStateBatch(buffer);
    if (!batch) return;
    const receivedAt = Date.now();
    const estimatedServerTime = Math.round(this.serverClock.toServerTime(receivedAt));
    const unsignedLag = ((estimatedServerTime >>> 0) - batch.serverTime) >>> 0;
    const lagSeconds = unsignedLag <= 2_000 ? unsignedLag / 1000 : 0;
    for (const state of batch.records) {
      const projectedX = Math.max(21, Math.min(WORLD.width - 21, state.x + state.velocityX * lagSeconds));
      const projectedY = Math.max(21, Math.min(WORLD.height - 21, state.y + state.velocityY * lagSeconds));
      if (state.slot === this.localSlot) {
        this.callbacks.onCorrection(projectedX, projectedY, state.velocityX, state.velocityY, state.sequence);
        continue;
      }
      const player = this.playersBySlot.get(state.slot);
      if (!player) continue;
      player.x = projectedX;
      player.y = projectedY;
      player.velocityX = state.velocityX;
      player.velocityY = state.velocityY;
      player.sequence = state.sequence;
      player.zone = state.zone;
      player.updatedAt = receivedAt;
      this.callbacks.onMovement({ ...player });
    }
  }

  private toOnlinePlayer(player: NetworkPlayer): OnlinePlayer {
    return { ...player, updatedAt: Date.now() };
  }

  private localPlayer(profile: PlayerIdentity, x: number, y: number): OnlinePlayer {
    return {
      ...profile,
      id: this.connectionId,
      authUserId: this.authUserId,
      slot: this.localSlot,
      x,
      y,
      velocityX: this.lastDirectionX * 220,
      velocityY: this.lastDirectionY * 220,
      sequence: this.sequence,
      zone: 1,
      updatedAt: Date.now(),
    };
  }

  private sendPing(sentAt = Date.now()): void {
    this.lastPingAt = sentAt;
    this.sendJson({ type: "ping", sentAt });
  }

  private sendJson(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async closeSocket(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, "Client reconnecting");
  }
}
