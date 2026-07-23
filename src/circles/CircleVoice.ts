import type { CircleSignalData, CircleState } from "../../shared/worldProtocol";
import { getOrCreateAnonymousSession } from "../services/supabase";

interface PeerState {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement;
  pendingCandidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  offerStarted: boolean;
  needsOffer: boolean;
}

interface IceServerResponse {
  iceServers?: RTCIceServer[];
  relayAvailable?: boolean;
}

export type CircleVoiceStatus = "idle" | "requesting" | "connected" | "muted" | "unavailable" | "error";

export class CircleVoice {
  private localStream: MediaStream | null = null;
  private peers = new Map<string, PeerState>();
  private circle: CircleState | null = null;
  private localPlayerId = "";
  private iceServers: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  private muted = false;
  private generation = 0;
  private startPromise: Promise<{ iceServers: RTCIceServer[]; stream: MediaStream }> | null = null;
  private permissionFailed = false;

  constructor(
    private readonly endpoint: string,
    private readonly sendSignal: (targetPlayerId: string, signal: CircleSignalData) => void,
    private readonly onStatus: (status: CircleVoiceStatus, detail?: string) => void,
    private readonly onMutedChange: (muted: boolean) => void,
  ) {}

  get isMuted(): boolean {
    return this.muted;
  }

  get canRetry(): boolean {
    return this.permissionFailed
      || [...this.peers.values()].some(peer => peer.connection.connectionState === "failed");
  }

  async join(circle: CircleState, localPlayerId: string): Promise<void> {
    const changedCircle = this.circle?.id !== circle.id;
    this.circle = circle;
    this.localPlayerId = localPlayerId;
    if (changedCircle) {
      await this.leave(false);
      this.circle = circle;
      this.localPlayerId = localPlayerId;
    }

    const generation = this.generation;
    if (!this.localStream) {
      if (this.permissionFailed) {
        await this.syncPeers();
        this.onStatus("unavailable", "Microphone access is off. You can still listen and play.");
        return;
      }
      this.onStatus("requesting", "Allow microphone access to join private Circle voice.");
      const pending = this.startPromise ?? Promise.all([
        this.loadIceServers(),
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        }),
      ]).then(([iceServers, stream]) => ({ iceServers, stream }));
      this.startPromise = pending;
      try {
        const started = await pending;
        if (generation !== this.generation) {
          started.stream.getTracks().forEach(track => track.stop());
          if (this.startPromise === pending) this.startPromise = null;
          return;
        }
        this.iceServers = started.iceServers;
        this.applyIceServersToPeers();
        this.localStream = started.stream;
        if (this.startPromise === pending) this.startPromise = null;
      } catch (error) {
        if (this.startPromise === pending) this.startPromise = null;
        if (generation !== this.generation) return;
        this.permissionFailed = true;
        console.warn("Blockaroo Circle voice could not start", error);
        const iceServers = await this.loadIceServers();
        if (generation !== this.generation) return;
        this.iceServers = iceServers;
        this.applyIceServersToPeers();
        await this.syncPeers();
        if (generation !== this.generation) return;
        this.onStatus("unavailable", "Microphone access is off. You can still listen and play.");
        return;
      }
    }
    this.syncTracks();
    await this.syncPeers();
    this.onStatus(this.muted ? "muted" : "connected");
  }

  async handleSignal(fromPlayerId: string, signal: CircleSignalData): Promise<void> {
    if (!this.circle?.members.some(member => member.playerId === fromPlayerId) || fromPlayerId === this.localPlayerId) return;
    const peer = this.ensurePeer(fromPlayerId);
    // A remote offer can arrive while this browser is still waiting for
    // microphone permission. If permission has since resolved, make sure the
    // answer includes our audio instead of leaving a permanently receive-only
    // connection.
    this.addLocalTracks(peer);
    try {
      if ("description" in signal) {
        const description = signal.description as RTCSessionDescriptionInit;
        if (description.type === "offer") {
          peer.offerStarted = true;
          const polite = this.localPlayerId.localeCompare(fromPlayerId) > 0;
          const collision = peer.makingOffer || peer.connection.signalingState !== "stable";
          if (collision && !polite) return;
          if (collision) await peer.connection.setLocalDescription({ type: "rollback" });
          await peer.connection.setRemoteDescription(description);
          await this.flushCandidates(peer);
          await peer.connection.setLocalDescription(await peer.connection.createAnswer());
          if (peer.connection.localDescription) {
            this.sendSignal(fromPlayerId, { description: plainDescription(peer.connection.localDescription) });
          }
        } else {
          await peer.connection.setRemoteDescription(description);
          await this.flushCandidates(peer);
        }
        return;
      }
      const candidate = signal.candidate as RTCIceCandidateInit;
      if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(candidate);
      else peer.pendingCandidates.push(candidate);
    } catch (error) {
      console.warn("Blockaroo ignored an invalid Circle voice signal", error);
    }
  }

  toggleMuted(force?: boolean): boolean {
    this.muted = force ?? !this.muted;
    this.syncTracks();
    this.onMutedChange(this.muted);
    this.onStatus(this.muted ? "muted" : this.localStream ? "connected" : "idle");
    return this.muted;
  }

  async retry(): Promise<void> {
    if (!this.circle || !this.localPlayerId) return;
    const circle = this.circle;
    const localPlayerId = this.localPlayerId;
    await this.leave(false);
    this.circle = circle;
    this.localPlayerId = localPlayerId;
    await this.join(circle, localPlayerId);
  }

  setPeerMuted(playerId: string, muted: boolean): void {
    const peer = this.peers.get(playerId);
    if (peer) peer.audio.muted = muted;
  }

  resumeAudio(): void {
    for (const peer of this.peers.values()) void peer.audio.play().catch(() => undefined);
  }

  async leave(resetCircle = true): Promise<void> {
    this.generation += 1;
    for (const peer of this.peers.values()) {
      peer.connection.close();
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    this.peers.clear();
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
    this.startPromise = null;
    this.permissionFailed = false;
    this.muted = false;
    if (resetCircle) {
      this.circle = null;
      this.localPlayerId = "";
    }
    this.onStatus("idle");
  }

  private async syncPeers(): Promise<void> {
    if (!this.circle) return;
    const remoteIds = new Set(this.circle.members.map(member => member.playerId).filter(id => id !== this.localPlayerId));
    for (const [playerId, peer] of this.peers) {
      if (!remoteIds.has(playerId)) {
        peer.connection.close();
        peer.audio.remove();
        this.peers.delete(playerId);
      }
    }
    for (const remoteId of remoteIds) {
      const peer = this.ensurePeer(remoteId);
      const addedTracks = this.addLocalTracks(peer);
      const startsInitialOffer = !peer.offerStarted && this.localPlayerId.localeCompare(remoteId) < 0;
      // If we originally answered without a microphone track, adding that
      // track requires a second offer. Only the side that added late media
      // initiates that renegotiation, which keeps the normal initial offer
      // deterministic while repairing the late-permission case.
      if ((startsInitialOffer || (peer.offerStarted && addedTracks) || peer.needsOffer)
        && peer.connection.signalingState === "stable") {
        if (!this.localStream) this.ensureAudioReceiver(peer);
        if (await this.makeOffer(remoteId, peer)) peer.needsOffer = false;
      }
    }
  }

  private ensurePeer(remoteId: string): PeerState {
    const existing = this.peers.get(remoteId);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.dataset.circlePeer = remoteId;
    audio.hidden = true;
    document.body.append(audio);
    const peer: PeerState = {
      connection,
      audio,
      pendingCandidates: [],
      makingOffer: false,
      offerStarted: false,
      needsOffer: false,
    };
    this.peers.set(remoteId, peer);
    connection.addEventListener("icecandidate", event => {
      if (event.candidate) this.sendSignal(remoteId, { candidate: plainCandidate(event.candidate) });
    });
    connection.addEventListener("track", event => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => undefined);
    });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") {
        this.onStatus("error", "A Circle voice connection failed. Try leaving and rejoining.");
      }
    });
    return peer;
  }

  private addLocalTracks(peer: PeerState): boolean {
    if (!this.localStream) return false;
    const senderTrackIds = new Set(
      peer.connection.getSenders()
        .map(sender => sender.track?.id)
        .filter((id): id is string => Boolean(id)),
    );
    let added = false;
    for (const track of this.localStream.getAudioTracks()) {
      if (senderTrackIds.has(track.id)) continue;
      peer.connection.addTrack(track, this.localStream);
      added = true;
    }
    return added;
  }

  private ensureAudioReceiver(peer: PeerState): void {
    const hasAudioTransceiver = peer.connection.getTransceivers()
      .some(transceiver => transceiver.receiver.track.kind === "audio");
    if (!hasAudioTransceiver) peer.connection.addTransceiver("audio", { direction: "recvonly" });
  }

  private async makeOffer(remoteId: string, peer: PeerState): Promise<boolean> {
    if (peer.makingOffer || peer.connection.signalingState !== "stable") return false;
    try {
      peer.makingOffer = true;
      peer.offerStarted = true;
      await peer.connection.setLocalDescription(await peer.connection.createOffer());
      if (peer.connection.localDescription) {
        this.sendSignal(remoteId, { description: plainDescription(peer.connection.localDescription) });
      }
      return true;
    } catch (error) {
      console.warn("Blockaroo Circle voice could not negotiate a peer", error);
      this.onStatus("error", "A Circle voice connection failed. Tap retry.");
      return false;
    } finally {
      peer.makingOffer = false;
    }
  }

  private applyIceServersToPeers(): void {
    for (const peer of this.peers.values()) {
      try {
        peer.connection.setConfiguration({ iceServers: this.iceServers });
        if (peer.offerStarted) {
          peer.connection.restartIce();
          peer.needsOffer = true;
        }
      } catch {
        // The next peer created for this Circle still receives the refreshed
        // server list. Existing connected audio can continue on its current
        // ICE route when a browser rejects live reconfiguration.
      }
    }
  }

  private syncTracks(): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !this.muted;
  }

  private async flushCandidates(peer: PeerState): Promise<void> {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.connection.addIceCandidate(candidate);
    }
  }

  private async loadIceServers(): Promise<RTCIceServer[]> {
    if (!this.endpoint.trim()) return this.iceServers;
    try {
      const session = await getOrCreateAnonymousSession();
      const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/ice-servers`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!response.ok) return this.iceServers;
      const result = await response.json() as IceServerResponse;
      return Array.isArray(result.iceServers) && result.iceServers.length ? result.iceServers : this.iceServers;
    } catch {
      return this.iceServers;
    }
  }
}

function plainDescription(description: RTCSessionDescription): { type: RTCSdpType; sdp?: string } {
  return { type: description.type, ...(description.sdp ? { sdp: description.sdp } : {}) };
}

function plainCandidate(candidate: RTCIceCandidate): {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
} {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}
