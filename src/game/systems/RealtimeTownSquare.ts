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
  onStatus(status: ConnectionStatus): void;
}

const CHANNEL_NAME = "city:nashville:town-square";

export class RealtimeTownSquare {
  readonly connectionId = crypto.randomUUID();
  private channel: RealtimeChannel | null = null;
  private authUserId = "";
  private currentState: OnlinePlayer | null = null;
  private subscribed = false;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  async connect(profile: PlayerIdentity, x: number, y: number): Promise<string> {
    if (!supabase) throw new Error("Supabase environment variables are missing.");

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

    this.authUserId = session.user.id;
    this.currentState = this.makeState(profile, x, y);
    this.channel = supabase.channel(CHANNEL_NAME, {
      config: {
        presence: { key: this.connectionId },
        broadcast: { self: false, ack: false },
      },
    });

    this.channel
      .on("presence", { event: "sync" }, () => this.syncPresence())
      .on("broadcast", { event: "player_move" }, ({ payload }) => {
        const player = payload as OnlinePlayer;
        if (player.id !== this.connectionId) this.callbacks.onMovement(player);
      })
      .subscribe(async status => {
        if (status === "SUBSCRIBED") {
          this.subscribed = true;
          if (this.currentState) await this.channel?.track(this.currentState);
          this.callbacks.onStatus("online");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.callbacks.onStatus("error");
        } else if (status === "CLOSED") {
          this.subscribed = false;
          this.callbacks.onStatus("offline");
        }
      });

    return this.connectionId;
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
    if (!supabase || !this.channel) return;
    await this.channel.untrack();
    await supabase.removeChannel(this.channel);
    this.channel = null;
    this.subscribed = false;
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

  private syncPresence(): void {
    if (!this.channel) return;
    const state = this.channel.presenceState<OnlinePlayer>();
    const players = Object.values(state)
      .flat()
      .filter(player => player.id !== this.connectionId);
    this.callbacks.onPlayers(players);
  }
}
