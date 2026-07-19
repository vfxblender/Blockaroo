import type { RealtimeChannel } from "@supabase/supabase-js";
import { getOrCreateAnonymousSession, supabase } from "../../services/supabase";
import { WORLD } from "../config";
import type { PlayerIdentity } from "../types/world";
import type { BlockChatMessage, OnlinePlayer, TownSquareCallbacks, TownSquareTransport } from "./TownSquareTransport";

interface HelloPayload {
  player: OnlinePlayer;
  replyRequested: boolean;
}

const CHANNEL_NAME = "city:nashville:town-square";

export class RealtimeTownSquare implements TownSquareTransport {
  readonly mode = "supabase-fallback" as const;
  private _connectionId: string = crypto.randomUUID();
  private channel: RealtimeChannel | null = null;
  private authUserId = "";
  private currentState: OnlinePlayer | null = null;
  private subscribed = false;
  private generation = 0;
  private movementSequence = 0;
  private lastMovementSentAt = 0;
  private lastDirectionX = 0;
  private lastDirectionY = 0;

  constructor(private readonly callbacks: TownSquareCallbacks) {}

  get connectionId(): string {
    return this._connectionId;
  }

  async connect(profile: PlayerIdentity, x: number, y: number): Promise<string> {
    if (!supabase) throw new Error("Supabase environment variables are missing.");

    const generation = ++this.generation;
    await this.removeCurrentChannel();
    this.callbacks.onStatus("connecting");
    const session = await getOrCreateAnonymousSession();
    if (generation !== this.generation) return this.connectionId;

    this.authUserId = session.user.id;
    // A stable key prevents refresh/reconnect ghosts from being counted as
    // separate people while the old socket is timing out on the server.
    this._connectionId = session.user.id;
    this.currentState = this.makeState(profile, x, y);
    const connectionId = this.connectionId;
    const channel = supabase.channel(CHANNEL_NAME, {
      config: {
        presence: { key: connectionId },
        broadcast: { self: false, ack: false },
      },
    });
    this.channel = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        if (generation === this.generation) this.syncPresence(channel, connectionId);
      })
      .on("broadcast", { event: "player_move" }, ({ payload }) => {
        const player = this.normalizePlayer(payload as Partial<OnlinePlayer>);
        if (generation === this.generation && player.id !== connectionId) this.callbacks.onMovement(player);
      })
      .on("broadcast", { event: "player_hello" }, ({ payload }) => {
        if (generation !== this.generation) return;
        const hello = payload as HelloPayload;
        if (hello.player.id === connectionId) return;
        this.callbacks.onMovement(this.normalizePlayer(hello.player));
        if (hello.replyRequested) this.sendHello(false);
      })
      .on("broadcast", { event: "chat_message" }, ({ payload }) => {
        if (generation !== this.generation) return;
        const rawMessage = payload as BlockChatMessage;
        const message = {
          ...rawMessage,
          kind: rawMessage.kind === "image" ? "image" : "text",
          player: this.normalizePlayer(rawMessage.player),
        } satisfies BlockChatMessage;
        if (message.player.id !== connectionId && this.isNearby(message.player)) this.callbacks.onChat(message);
      })
      .subscribe(async status => {
        if (generation !== this.generation) return;
        if (status === "SUBSCRIBED") {
          this.subscribed = true;
          const trackStatus = this.currentState ? await channel.track(this.currentState) : "error";
          if (generation !== this.generation) return;
          if (trackStatus === "ok") {
            this.callbacks.onStatus("online");
            this.sendHello(true);
          } else {
            console.error("Supabase Presence track failed", trackStatus);
            this.callbacks.onStatus("error");
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.callbacks.onStatus("error");
        } else if (status === "CLOSED") {
          this.subscribed = false;
          this.callbacks.onStatus("offline");
        }
      });

    return connectionId;
  }

  updatePresence(profile: PlayerIdentity, x: number, y: number): void {
    this.currentState = this.makeState(profile, x, y);
    if (this.subscribed) void this.channel?.track(this.currentState);
  }

  sendMovement(profile: PlayerIdentity, x: number, y: number, rawDirectionX: number, rawDirectionY: number): void {
    if (!this.channel || !this.subscribed) return;
    const length = Math.hypot(rawDirectionX, rawDirectionY);
    const directionX = length > 0.001 ? rawDirectionX / length : 0;
    const directionY = length > 0.001 ? rawDirectionY / length : 0;
    const now = Date.now();
    const changed = Math.abs(directionX - this.lastDirectionX) > 0.025 || Math.abs(directionY - this.lastDirectionY) > 0.025;
    const moving = directionX !== 0 || directionY !== 0;
    if (!changed && now - this.lastMovementSentAt < (moving ? 1_000 : 15_000)) return;
    this.lastDirectionX = directionX;
    this.lastDirectionY = directionY;
    this.lastMovementSentAt = now;
    this.movementSequence = (this.movementSequence + 1) & 0xffff;
    this.currentState = this.makeState(profile, x, y, directionX * 220, directionY * 220);
    void this.channel.send({
      type: "broadcast",
      event: "player_move",
      payload: this.currentState,
    });
  }

  sendChat(profile: PlayerIdentity, text: string, x: number, y: number): BlockChatMessage | null {
    if (!this.channel || !this.subscribed) return null;
    this.currentState = this.makeState(profile, x, y);
    const message: BlockChatMessage = {
      id: crypto.randomUUID(),
      player: this.currentState,
      kind: "text",
      text: text.slice(0, 120),
      sentAt: Date.now(),
      durationMs: 12_000,
    };
    void this.channel.send({
      type: "broadcast",
      event: "chat_message",
      payload: message,
    });
    return message;
  }

  async sendImage(profile: PlayerIdentity, imageDataUrl: string, x: number, y: number): Promise<BlockChatMessage | null> {
    if (!this.channel || !this.subscribed) return null;
    this.currentState = this.makeState(profile, x, y);
    const message: BlockChatMessage = {
      id: crypto.randomUUID(),
      player: this.currentState,
      kind: "image",
      // Keep text present so an older client degrades to an empty speech card
      // instead of throwing while a new deployment is rolling out.
      text: "",
      imageDataUrl,
      sentAt: Date.now(),
      durationMs: 12_000,
    };
    void this.channel.send({
      type: "broadcast",
      event: "chat_message",
      payload: message,
    });
    return message;
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    await this.removeCurrentChannel();
  }

  private makeState(profile: PlayerIdentity, x: number, y: number, velocityX = 0, velocityY = 0): OnlinePlayer {
    return {
      id: this.connectionId,
      authUserId: this.authUserId,
      username: profile.username,
      color: profile.color,
      x,
      y,
      slot: 0,
      velocityX,
      velocityY,
      sequence: this.movementSequence,
      zone: 1,
      updatedAt: Date.now(),
    };
  }

  private syncPresence(channel: RealtimeChannel, connectionId: string): void {
    const state = channel.presenceState<OnlinePlayer>();
    const latestByUser = new Map<string, OnlinePlayer>();
    for (const [presenceKey, presences] of Object.entries(state)) {
      for (const presence of presences) {
        const player = this.normalizePlayer({ ...presence, id: presenceKey });
        const existing = latestByUser.get(presenceKey);
        if (!existing || player.updatedAt >= existing.updatedAt) latestByUser.set(presenceKey, player);
      }
    }
    const allPlayers = [...latestByUser.values()];
    this.callbacks.onCount(allPlayers.length);
    this.callbacks.onPlayers(allPlayers.filter(player => player.id !== connectionId));
  }

  private sendHello(replyRequested: boolean): void {
    if (!this.channel || !this.subscribed || !this.currentState) return;
    void this.channel.send({
      type: "broadcast",
      event: "player_hello",
      payload: { player: this.currentState, replyRequested } satisfies HelloPayload,
    });
  }

  private isNearby(player: OnlinePlayer): boolean {
    if (!this.currentState) return false;
    return Math.hypot(player.x - this.currentState.x, player.y - this.currentState.y) <= WORLD.chatRadius;
  }

  private normalizePlayer(player: Partial<OnlinePlayer>): OnlinePlayer {
    return {
      id: typeof player.id === "string" ? player.id : crypto.randomUUID(),
      authUserId: typeof player.authUserId === "string" ? player.authUserId : "",
      username: typeof player.username === "string" ? player.username : "New Neighbor",
      color: typeof player.color === "string" ? player.color : "#ff6b6b",
      slot: typeof player.slot === "number" ? player.slot : 0,
      x: typeof player.x === "number" ? player.x : WORLD.width / 2,
      y: typeof player.y === "number" ? player.y : WORLD.height / 2,
      velocityX: typeof player.velocityX === "number" ? player.velocityX : 0,
      velocityY: typeof player.velocityY === "number" ? player.velocityY : 0,
      sequence: typeof player.sequence === "number" ? player.sequence : 0,
      zone: player.zone === 2 ? 2 : 1,
      updatedAt: typeof player.updatedAt === "number" ? player.updatedAt : Date.now(),
    };
  }

  private async removeCurrentChannel(): Promise<void> {
    if (!supabase || !this.channel) return;
    const channel = this.channel;
    this.channel = null;
    this.subscribed = false;
    try {
      await channel.untrack();
    } finally {
      await supabase.removeChannel(channel);
    }
  }
}
