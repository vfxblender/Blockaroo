import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../../services/supabase";
import type { PlayerIdentity } from "../types/world";

export interface OnlinePlayer extends PlayerIdentity {
  authUserId: string;
  x: number;
  y: number;
  updatedAt: number;
}

type ConnectionStatus = "connecting" | "online" | "offline" | "error";

interface RealtimeCallbacks {
  onPlayers(players: OnlinePlayer[]): void;
  onMovement(player: OnlinePlayer): void;
  onCount(count: number): void;
  onStatus(status: ConnectionStatus): void;
}

interface HelloPayload {
  player: OnlinePlayer;
  replyRequested: boolean;
}

const CHANNEL_NAME = "city:nashville:town-square";

export class RealtimeTownSquare {
  private _connectionId = crypto.randomUUID();
  private channel: RealtimeChannel | null = null;
  private authUserId = "";
  private currentState: OnlinePlayer | null = null;
  private subscribed = false;
  private generation = 0;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get connectionId(): string {
    return this._connectionId;
  }

  async connect(profile: PlayerIdentity, x: number, y: number): Promise<string> {
    if (!supabase) throw new Error("Supabase environment variables are missing.");

    const generation = ++this.generation;
    await this.removeCurrentChannel();
    this._connectionId = crypto.randomUUID();
    this.callbacks.onStatus("connecting");
    const existing = await supabase.auth.getSession();
    if (existing.error) throw existing.error;

    let session = existing.data.session;
    if (!session) {
      const anonymous = await supabase.auth.signInAnonymously();
      if (anonymous.error) throw anonymous.error;
      session = anonymous.data.session;
    }
    if (!session) throw new Error("Anonymous authentication did not return a session.");
    if (generation !== this.generation) return this.connectionId;

    this.authUserId = session.user.id;
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
        const player = payload as OnlinePlayer;
        if (generation === this.generation && player.id !== connectionId) this.callbacks.onMovement(player);
      })
      .on("broadcast", { event: "player_hello" }, ({ payload }) => {
        if (generation !== this.generation) return;
        const hello = payload as HelloPayload;
        if (hello.player.id === connectionId) return;
        this.callbacks.onMovement(hello.player);
        if (hello.replyRequested) this.sendHello(false);
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

  sendMovement(profile: PlayerIdentity, x: number, y: number): void {
    if (!this.channel || !this.subscribed) return;
    this.currentState = this.makeState(profile, x, y);
    void this.channel.send({
      type: "broadcast",
      event: "player_move",
      payload: this.currentState,
    });
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    await this.removeCurrentChannel();
  }

  private makeState(profile: PlayerIdentity, x: number, y: number): OnlinePlayer {
    return {
      id: this.connectionId,
      authUserId: this.authUserId,
      username: profile.username,
      color: profile.color,
      x,
      y,
      updatedAt: Date.now(),
    };
  }

  private syncPresence(channel: RealtimeChannel, connectionId: string): void {
    const state = channel.presenceState<OnlinePlayer>();
    const allPlayers = Object.entries(state).flatMap(([presenceKey, presences]) =>
      presences.map(player => ({ ...player, id: presenceKey })),
    );
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
