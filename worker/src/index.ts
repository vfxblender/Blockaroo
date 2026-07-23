import {
  DETAILED_PLAYER_LIMIT,
  MAX_INTEREST_PLAYERS,
  MOVEMENT_SPEED,
  PRELOADED_PLAYER_LIMIT,
  WORLD_PROTOCOL_VERSION,
  decodeMovementInput,
  encodeStateBatch,
  normalizeDirection,
  type ClientControlMessage,
  type InterestZone,
  type NearbyMediaType,
  type NetworkPlayer,
  type ServerControlMessage,
  type StateRecord,
  type WorldDescriptor,
} from "../../shared/worldProtocol.ts";
import { CircleCoordinator, type CircleParticipant } from "./circles.ts";
import { hasBlockBetween } from "./worldSafety.ts";

interface Env {
  TOWN_SQUARE: DurableObjectNamespace;
  TEMPORARY_MEDIA: R2Bucket;
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TICKET_SECRET: string;
  MEDIA_SECRET: string;
  CLOUDFLARE_TURN_KEY_ID: string;
  CLOUDFLARE_TURN_API_TOKEN: string;
}

interface TicketPayload {
  sub: string;
  exp: number;
  nonce: string;
  cityId: string;
  spaceId: string;
  anonymous: boolean;
  socialReady: boolean;
  blockedUserIds: string[];
}

interface MediaTokenPayload {
  kind: "media-upload" | "media-download";
  mediaId: string;
  mediaType?: NearbyMediaType;
  sub?: string;
  exp: number;
}

interface SocketAttachment {
  authUserId: string;
  isAnonymous: boolean;
  socialReady: boolean;
  blockedUserIds: string[];
  cityId: string;
  spaceId: string;
  initialized: boolean;
  playerId: string;
  slot: number;
  username: string;
  color: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  sequence: number;
  updatedAt: number;
  lastChatAt: number;
  lastPhotoAt: number;
  pendingPhotoId: string;
  pendingPhotoMediaType: NearbyMediaType;
  pendingPhotoExpiresAt: number;
}

interface ProjectedPosition {
  x: number;
  y: number;
}

interface AuthenticatedRequest {
  userId: string;
  accessToken: string;
  isAnonymous: boolean;
}

interface SocialPostRow {
  id: string;
  author_id: string;
  media_path: string | null;
  media_type: "image" | "gif" | null;
  pinned_to_home: boolean;
  expires_at: string;
}

interface IceServerResponse {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const WORLD_WIDTH = 2200;
const WORLD_HEIGHT = 1500;
const ACTIVE_CITY_ID = "nashville";
const ACTIVE_SPACE_ID = "town-square";
const ROOM_PLAYER_LIMIT = 1000;
const PLAYER_HALF_SIZE = 21;
const DETAIL_RADIUS = 650;
const PRELOAD_RADIUS = 1300;
const CHAT_RADIUS = 340;
const PHOTO_RECIPIENT_LIMIT = 12;
const FULL_RECONCILE_INTERVAL_MS = 15_000;
const CHAT_RATE_LIMIT_MS = 900;
const PHOTO_RATE_LIMIT_MS = 12_000;
const PHOTO_GRANT_LIFETIME_MS = 30_000;
const PHOTO_DOWNLOAD_LIFETIME_MS = 45_000;
const PHOTO_RETENTION_MS = 2 * 60_000;
const MAX_PHOTO_BYTES = 110 * 1024;
const MAX_TEMPORARY_GIF_BYTES = 256 * 1024;
const MAX_SOCIAL_MEDIA_BYTES = 512 * 1024;
const MAX_SOCIAL_GIF_BYTES = 1024 * 1024;
const MAX_MOVEMENT_REWIND_MS = 500;
const TICKET_LIFETIME_SECONDS = 75;
const MAX_TEXT_LENGTH = 120;
const MAX_CONTROL_MESSAGE_LENGTH = 16_384;
const PROFILE_NAME_LENGTH = 18;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PATH_SEGMENT_PATTERN = /^[a-z0-9-]+$/;
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_PREFIX = "temporary/";
const SOCIAL_MEDIA_PREFIX = "social/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") return corsPreflight(origin, env);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "blockaroo-world", protocol: WORLD_PROTOCOL_VERSION }, 200, origin, env);
    }
    if (!isAllowedOrigin(origin, env)) return json({ error: "Origin not allowed." }, 403, origin, env);

    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (mediaMatch && MEDIA_ID_PATTERN.test(mediaMatch[1])) {
      if (request.method === "PUT") return uploadTemporaryMedia(request, env, origin, mediaMatch[1]);
      if (request.method === "GET") return readTemporaryMedia(request, env, origin, mediaMatch[1]);
    }

    const socialMediaMatch = url.pathname.match(/^\/social-media\/([^/]+)$/);
    if (socialMediaMatch && MEDIA_ID_PATTERN.test(socialMediaMatch[1])) {
      if (request.method === "PUT") return uploadSocialMedia(request, env, origin, socialMediaMatch[1]);
      if (request.method === "GET") return readSocialMedia(request, env, origin, socialMediaMatch[1]);
      if (request.method === "DELETE") return deleteSocialMedia(request, env, origin, socialMediaMatch[1]);
    }

    if (url.pathname === "/ice-servers" && request.method === "GET") {
      return createIceServers(request, env, origin);
    }

    if (url.pathname === "/account" && request.method === "DELETE") {
      return deleteAccount(request, env, origin);
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return createSocketSession(request, env, origin);
    }

    const worldMatch = url.pathname.match(/^\/world\/([^/]+)\/([^/]+)$/);
    if (worldMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const cityId = worldMatch[1].toLowerCase();
      const spaceId = worldMatch[2].toLowerCase();
      if (!PATH_SEGMENT_PATTERN.test(cityId) || !PATH_SEGMENT_PATTERN.test(spaceId)) {
        return json({ error: "Invalid world path." }, 400, origin, env);
      }

      const ticket = url.searchParams.get("ticket");
      const payload = ticket ? await verifyTicket(ticket, env.TICKET_SECRET) : null;
      if (!payload) return json({ error: "The world ticket is missing or expired." }, 401, origin, env);
      if (payload.cityId !== cityId || payload.spaceId !== spaceId) {
        return json({ error: "The world ticket does not match this space." }, 401, origin, env);
      }

      const roomId = env.TOWN_SQUARE.idFromName(`${cityId}:${spaceId}`);
      const headers = new Headers(request.headers);
      headers.set("X-Blockaroo-User", payload.sub);
      headers.set("X-Blockaroo-Anonymous", String(payload.anonymous));
      headers.set("X-Blockaroo-Social-Ready", String(payload.socialReady));
      headers.set("X-Blockaroo-Blocked", payload.blockedUserIds.join(","));
      headers.set("X-Blockaroo-City", cityId);
      headers.set("X-Blockaroo-Space", spaceId);
      return env.TOWN_SQUARE.get(roomId).fetch(new Request("https://room.blockaroo/connect", { headers }));
    }

    return json({ error: "Not found." }, 404, origin, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredMedia(env));
  },
} satisfies ExportedHandler<Env>;

export class TownSquareRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly socketsBySlot = new Map<number, WebSocket>();
  private readonly knownByViewer = new Map<WebSocket, Map<number, InterestZone>>();
  private readonly viewersByPlayer = new Map<number, Set<WebSocket>>();
  private readonly lastFullReconcile = new Map<WebSocket, number>();
  private nextSlot = 1;
  private readonly circles: CircleCoordinator;
  private world: WorldDescriptor = {
    cityId: "nashville",
    spaceId: "town-square",
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    const existing = ctx.getWebSockets();
    for (const socket of existing) {
      const attachment = this.readAttachment(socket);
      if (!attachment?.initialized) continue;
      this.world = {
        cityId: attachment.cityId || "nashville",
        spaceId: attachment.spaceId || "town-square",
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
      };
      this.socketsBySlot.set(attachment.slot, socket);
      const candidate = attachment.slot >= 0xffff ? 1 : attachment.slot + 1;
      if (!this.socketsBySlot.has(candidate)) this.nextSlot = candidate;
    }
    this.circles = new CircleCoordinator(ctx, {
      participant: userId => this.circleParticipant(userId),
      networkPlayer: userId => {
        const socket = this.socketForUser(userId);
        const state = socket ? this.readAttachment(socket) : null;
        return state?.initialized ? this.networkPlayer(state, 1, Date.now()) : null;
      },
      send: (userId, message) => {
        const socket = this.socketForUser(userId);
        if (socket) this.sendJson(socket, message);
      },
      publishPresence: userId => {
        const socket = this.socketForUser(userId);
        const state = socket ? this.readAttachment(socket) : null;
        if (state?.initialized) this.publishProfile(state);
      },
      blockedBetween: (firstUserId, secondUserId) => {
        const firstSocket = this.socketForUser(firstUserId);
        const secondSocket = this.socketForUser(secondUserId);
        const first = firstSocket ? this.readAttachment(firstSocket) : null;
        const second = secondSocket ? this.readAttachment(secondSocket) : null;
        return Boolean(first && second && hasBlockBetween(first, second));
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const authUserId = request.headers.get("X-Blockaroo-User");
    if (!authUserId) return new Response("Missing authenticated user.", { status: 401 });
    const cityId = request.headers.get("X-Blockaroo-City") || "nashville";
    const spaceId = request.headers.get("X-Blockaroo-Space") || "town-square";
    this.world = { cityId, spaceId, width: WORLD_WIDTH, height: WORLD_HEIGHT };

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = {
      authUserId,
      isAnonymous: request.headers.get("X-Blockaroo-Anonymous") !== "false",
      socialReady: request.headers.get("X-Blockaroo-Social-Ready") === "true",
      blockedUserIds: (request.headers.get("X-Blockaroo-Blocked") ?? "")
        .split(",")
        .filter(value => /^[0-9a-f-]{36}$/i.test(value))
        .slice(0, 200),
      cityId,
      spaceId,
      initialized: false,
      playerId: authUserId,
      slot: 0,
      username: "New Neighbor",
      color: "#ff6b6b",
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      velocityX: 0,
      velocityY: 0,
      sequence: 0,
      updatedAt: Date.now(),
      lastChatAt: 0,
      lastPhotoAt: 0,
      pendingPhotoId: "",
      pendingPhotoMediaType: "image",
      pendingPhotoExpiresAt: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.readAttachment(socket);
    if (!attachment) return this.close(socket, 1011, "Missing socket state");

    if (typeof message === "string") {
      if (message.length > MAX_CONTROL_MESSAGE_LENGTH) return this.sendError(socket, "message_too_large", "That message is too large.");
      let control: ClientControlMessage;
      try {
        control = JSON.parse(message) as ClientControlMessage;
      } catch {
        return this.sendError(socket, "bad_json", "The control message is not valid JSON.");
      }
      if (!control || typeof control !== "object" || typeof control.type !== "string") {
        return this.sendError(socket, "bad_control", "The control message has no valid type.");
      }
      await this.handleControl(socket, attachment, control);
      return;
    }

    if (!attachment.initialized) return this.sendError(socket, "hello_required", "Send hello before movement.");
    const input = decodeMovementInput(message);
    if (!input) return this.sendError(socket, "bad_movement", "The movement packet is invalid.");
    await this.handleMovement(socket, attachment, input.sequence, input.directionX, input.directionY, input.sentAtLow16);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.removeSocket(socket, true, !wasClean || code === 4001);
    try {
      socket.close(code, reason);
    } catch {
      if (!wasClean) console.warn("Unclean Blockaroo WebSocket close", code, reason);
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error("Blockaroo room WebSocket error", error);
    await this.removeSocket(socket, true, true);
    this.close(socket, 1011, "World connection error");
  }

  async alarm(): Promise<void> {
    await this.circles.alarm();
  }

  private async handleControl(socket: WebSocket, attachment: SocketAttachment, message: ClientControlMessage): Promise<void> {
    if (message.type === "hello") {
      if (attachment.initialized) return;
      if (message.protocol !== WORLD_PROTOCOL_VERSION) {
        this.sendError(socket, "protocol_mismatch", "Refresh Blockaroo to use the current world protocol.");
        return this.close(socket, 1002, "Protocol mismatch");
      }
      await this.initializeSocket(socket, attachment, message.username, message.color, message.spawnX, message.spawnY);
      return;
    }
    if (!attachment.initialized) return this.sendError(socket, "hello_required", "Send hello before other messages.");

    if (message.type === "profile") {
      const now = Date.now();
      const projected = this.project(attachment, now);
      attachment.x = projected.x;
      attachment.y = projected.y;
      attachment.username = cleanUsername(message.username);
      attachment.color = cleanColor(message.color);
      attachment.updatedAt = now;
      socket.serializeAttachment(attachment);
      this.publishProfile(attachment);
      this.circles.refreshParticipant(attachment.authUserId);
      return;
    }
    if (message.type === "ping") {
      this.reconcileViewer(socket, Date.now() - (this.lastFullReconcile.get(socket) ?? 0) >= FULL_RECONCILE_INTERVAL_MS);
      this.sendJson(socket, { type: "pong", sentAt: finite(message.sentAt, 0), serverTime: Date.now() });
      return;
    }
    if (message.type === "chat") {
      this.publishChat(socket, attachment, message.text);
      return;
    }
    if (message.type === "photo-grant") {
      await this.issuePhotoGrant(socket, attachment, message.mediaType);
      return;
    }
    if (message.type === "photo") {
      await this.publishPhoto(socket, attachment, message.mediaId);
      return;
    }
    await this.circles.handle(this.circleParticipantFromAttachment(attachment), message);
  }

  private async initializeSocket(
    socket: WebSocket,
    attachment: SocketAttachment,
    username: string,
    color: string,
    spawnX: number,
    spawnY: number,
  ): Promise<void> {
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === socket) continue;
      const state = this.readAttachment(existing);
      if (state?.initialized && state.authUserId === attachment.authUserId) {
        this.close(existing, 4001, "A newer tab replaced this connection");
        await this.removeSocket(existing, false, true);
      }
    }
    if (this.onlineCount() >= ROOM_PLAYER_LIMIT) {
      this.sendError(socket, "room_full", "This community space is full. Try again in a moment.");
      this.close(socket, 4003, "World is full");
      return;
    }

    attachment.initialized = true;
    attachment.slot = this.allocateSlot();
    attachment.playerId = attachment.authUserId;
    attachment.username = cleanUsername(username);
    attachment.color = cleanColor(color);
    attachment.x = clamp(finite(spawnX, WORLD_WIDTH / 2), PLAYER_HALF_SIZE, WORLD_WIDTH - PLAYER_HALF_SIZE);
    attachment.y = clamp(finite(spawnY, WORLD_HEIGHT / 2), PLAYER_HALF_SIZE, WORLD_HEIGHT - PLAYER_HALF_SIZE);
    attachment.updatedAt = Date.now();
    socket.serializeAttachment(attachment);
    this.socketsBySlot.set(attachment.slot, socket);
    this.knownByViewer.set(socket, new Map());

    this.sendJson(socket, {
      type: "welcome",
      protocol: WORLD_PROTOCOL_VERSION,
      playerId: attachment.playerId,
      slot: attachment.slot,
      serverTime: Date.now(),
      onlineCount: this.onlineCount(),
      world: this.world,
    });
    this.reconcileViewer(socket, true);
    this.refreshMoverAudience(attachment);
    this.broadcastCount();
    await this.circles.restoreParticipant(attachment.authUserId);
  }

  private async handleMovement(
    socket: WebSocket,
    attachment: SocketAttachment,
    sequence: number,
    rawDirectionX: number,
    rawDirectionY: number,
    sentAtLow16: number,
  ): Promise<void> {
    if (sequence === attachment.sequence || !isNewerSequence(sequence, attachment.sequence)) return;
    const now = Date.now();
    const packetAge = (((now & 0xffff) - sentAtLow16) & 0xffff);
    const effectiveTime = packetAge <= MAX_MOVEMENT_REWIND_MS ? now - packetAge : now;
    const projected = this.project(attachment, effectiveTime);
    const direction = normalizeDirection(rawDirectionX, rawDirectionY);
    const nextVelocityX = Math.round(direction.x * MOVEMENT_SPEED);
    const nextVelocityY = Math.round(direction.y * MOVEMENT_SPEED);
    const directionChanged = nextVelocityX !== attachment.velocityX || nextVelocityY !== attachment.velocityY;

    attachment.x = projected.x;
    attachment.y = projected.y;
    attachment.velocityX = nextVelocityX;
    attachment.velocityY = nextVelocityY;
    attachment.sequence = sequence;
    attachment.updatedAt = effectiveTime;
    socket.serializeAttachment(attachment);

    this.reconcileViewer(socket, now - (this.lastFullReconcile.get(socket) ?? 0) >= FULL_RECONCILE_INTERVAL_MS);
    this.refreshMoverAudience(attachment);
    this.sendState(socket, attachment, 1, now);
    if (directionChanged) this.publishStateChange(attachment, now);
    await this.circles.checkPosition(attachment.authUserId, attachment.x, attachment.y);
  }

  private reconcileViewer(viewerSocket: WebSocket, full: boolean): void {
    const viewer = this.readAttachment(viewerSocket);
    if (!viewer?.initialized) return;
    const now = Date.now();
    const known = this.ensureKnownMap(viewerSocket);
    if (!full) return;

    const viewerPosition = this.project(viewer, now);
    const candidates: Array<{ state: SocketAttachment; distanceSquared: number }> = [];
    for (const candidateSocket of this.ctx.getWebSockets()) {
      if (candidateSocket === viewerSocket) continue;
      const candidate = this.readAttachment(candidateSocket);
      if (!candidate?.initialized) continue;
      if (hasBlockBetween(viewer, candidate)) continue;
      const position = this.project(candidate, now);
      const dx = position.x - viewerPosition.x;
      const dy = position.y - viewerPosition.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= PRELOAD_RADIUS * PRELOAD_RADIUS) candidates.push({ state: candidate, distanceSquared });
    }
    candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);

    const desired = new Map<number, InterestZone>();
    let detailed = 0;
    let preloaded = 0;
    for (const candidate of candidates) {
      if (candidate.distanceSquared <= DETAIL_RADIUS * DETAIL_RADIUS && detailed < DETAILED_PLAYER_LIMIT) {
        desired.set(candidate.state.slot, 1);
        detailed += 1;
      } else if (preloaded < PRELOADED_PLAYER_LIMIT) {
        desired.set(candidate.state.slot, 2);
        preloaded += 1;
      }
      if (desired.size >= MAX_INTEREST_PLAYERS) break;
    }

    for (const [slot] of known) {
      if (!desired.has(slot)) this.forgetPlayer(viewerSocket, slot);
    }
    const initialRecords: StateRecord[] = [];
    for (const [slot, zone] of desired) {
      const candidateSocket = this.socketsBySlot.get(slot);
      const candidate = candidateSocket ? this.readAttachment(candidateSocket) : null;
      if (!candidate?.initialized) continue;
      const previousZone = known.get(slot);
      if (!previousZone) {
        this.rememberPlayer(viewerSocket, candidate, zone, now);
      } else {
        if (previousZone !== zone) {
          known.set(slot, zone);
          this.sendJson(viewerSocket, { type: "zone", slot, zone });
        }
        if (zone === 1 && (candidate.velocityX !== 0 || candidate.velocityY !== 0)) {
          initialRecords.push(this.stateRecord(candidate, zone, now));
        }
      }
    }
    if (initialRecords.length) this.sendBinary(viewerSocket, encodeStateBatch(now, initialRecords));
    this.lastFullReconcile.set(viewerSocket, now);
  }

  private refreshMoverAudience(mover: SocketAttachment): void {
    const now = Date.now();
    const moverPosition = this.project(mover, now);
    const existingViewers = new Set(this.viewersByPlayer.get(mover.slot) ?? []);
    const nearby: Array<{ socket: WebSocket; distanceSquared: number }> = [];

    for (const viewerSocket of this.ctx.getWebSockets()) {
      const viewer = this.readAttachment(viewerSocket);
      if (!viewer?.initialized || viewer.slot === mover.slot) continue;
      if (hasBlockBetween(mover, viewer)) continue;
      const viewerPosition = this.project(viewer, now);
      const dx = moverPosition.x - viewerPosition.x;
      const dy = moverPosition.y - viewerPosition.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= PRELOAD_RADIUS * PRELOAD_RADIUS) nearby.push({ socket: viewerSocket, distanceSquared });
    }
    nearby.sort((left, right) => left.distanceSquared - right.distanceSquared);

    const candidates = new Set<WebSocket>(existingViewers);
    for (const candidate of nearby.slice(0, MAX_INTEREST_PLAYERS + 20)) candidates.add(candidate.socket);
    for (const viewerSocket of candidates) {
      const viewer = this.readAttachment(viewerSocket);
      if (!viewer?.initialized) continue;
      const known = this.ensureKnownMap(viewerSocket);
      const currentZone = known.get(mover.slot);
      if (hasBlockBetween(mover, viewer)) {
        if (currentZone) this.forgetPlayer(viewerSocket, mover.slot);
        continue;
      }
      const viewerPosition = this.project(viewer, now);
      const dx = moverPosition.x - viewerPosition.x;
      const dy = moverPosition.y - viewerPosition.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > PRELOAD_RADIUS * PRELOAD_RADIUS) {
        if (currentZone) this.forgetPlayer(viewerSocket, mover.slot);
        continue;
      }
      const desiredZone: InterestZone = distanceSquared <= DETAIL_RADIUS * DETAIL_RADIUS ? 1 : 2;
      if (!currentZone) {
        const detailedCount = countZone(known, 1);
        const preloadedCount = countZone(known, 2);
        if ((desiredZone === 1 && detailedCount < DETAILED_PLAYER_LIMIT)
          || (desiredZone === 2 && preloadedCount < PRELOADED_PLAYER_LIMIT)) {
          this.rememberPlayer(viewerSocket, mover, desiredZone, now);
        }
      } else if (currentZone !== desiredZone
        && (desiredZone === 1 ? countZone(known, 1) < DETAILED_PLAYER_LIMIT : countZone(known, 2) < PRELOADED_PLAYER_LIMIT)) {
        known.set(mover.slot, desiredZone);
        this.sendJson(viewerSocket, { type: "zone", slot: mover.slot, zone: desiredZone });
      }
    }
  }

  private publishStateChange(player: SocketAttachment, now: number): void {
    const viewers = this.viewersByPlayer.get(player.slot);
    if (!viewers) return;
    for (const viewerSocket of viewers) {
      const zone = this.knownByViewer.get(viewerSocket)?.get(player.slot);
      if (zone) this.sendState(viewerSocket, player, zone, now);
    }
  }

  private publishProfile(player: SocketAttachment): void {
    const now = Date.now();
    const viewers = this.viewersByPlayer.get(player.slot);
    if (!viewers) return;
    for (const viewerSocket of viewers) {
      const zone = this.knownByViewer.get(viewerSocket)?.get(player.slot);
      if (zone) this.sendJson(viewerSocket, { type: "enter", player: this.networkPlayer(player, zone, now) });
    }
  }

  private publishChat(socket: WebSocket, player: SocketAttachment, rawText: string): void {
    const now = Date.now();
    if (now - player.lastChatAt < CHAT_RATE_LIMIT_MS) return this.sendError(socket, "chat_rate_limit", "Wait a moment before speaking again.");
    const text = typeof rawText === "string" ? rawText.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT_LENGTH) : "";
    if (!text) return;
    player.lastChatAt = now;
    socket.serializeAttachment(player);
    const id = crypto.randomUUID();
    this.forNearbyPlayers(player, CHAT_RADIUS, DETAILED_PLAYER_LIMIT, recipient => {
      this.sendJson(recipient, {
        type: "chat",
        id,
        player: this.networkPlayer(player, 1, now),
        text,
        sentAt: now,
        durationMs: 12_000,
      });
    }, socket);
  }

  private async issuePhotoGrant(socket: WebSocket, player: SocketAttachment, requestedType: NearbyMediaType): Promise<void> {
    const now = Date.now();
    if (!player.socialReady) return this.sendError(socket, "photo_account", "Create your account before sharing pictures.");
    if (now - player.lastPhotoAt < PHOTO_RATE_LIMIT_MS) return this.sendError(socket, "photo_rate_limit", "Wait before sharing another picture.");
    if (!this.env.MEDIA_SECRET || this.env.MEDIA_SECRET.length < 32) {
      console.error("MEDIA_SECRET must contain at least 32 characters.");
      return this.sendError(socket, "photo_unavailable", "Temporary pictures are not configured yet.");
    }

    const mediaId = crypto.randomUUID();
    const mediaType: NearbyMediaType = requestedType === "gif" ? "gif" : "image";
    const expiresAt = now + PHOTO_GRANT_LIFETIME_MS;
    player.lastPhotoAt = now;
    player.pendingPhotoId = mediaId;
    player.pendingPhotoMediaType = mediaType;
    player.pendingPhotoExpiresAt = expiresAt;
    socket.serializeAttachment(player);
    const uploadToken = await signPayload({
      kind: "media-upload",
      mediaId,
      mediaType,
      sub: player.authUserId,
      exp: Math.floor(expiresAt / 1000),
    } satisfies MediaTokenPayload, this.env.MEDIA_SECRET);
    this.sendJson(socket, { type: "photo-grant", mediaId, mediaType, uploadToken, expiresAt });
  }

  private async publishPhoto(socket: WebSocket, player: SocketAttachment, mediaId: string): Promise<void> {
    const now = Date.now();
    if (!MEDIA_ID_PATTERN.test(mediaId)
      || player.pendingPhotoId !== mediaId
      || player.pendingPhotoExpiresAt < now) {
      return this.sendError(socket, "photo_grant_invalid", "Request a new temporary photo upload.");
    }

    const mediaType = player.pendingPhotoMediaType === "gif" ? "gif" : "image";
    player.pendingPhotoId = "";
    player.pendingPhotoMediaType = "image";
    player.pendingPhotoExpiresAt = 0;
    socket.serializeAttachment(player);
    const object = await this.env.TEMPORARY_MEDIA.head(mediaKey(mediaId, mediaType));
    if (!object
      || object.customMetadata?.ownerId !== player.authUserId
      || object.customMetadata?.mediaType !== mediaType) {
      return this.sendError(socket, "photo_upload_missing", "The temporary picture did not finish uploading.");
    }

    const downloadToken = await signPayload({
      kind: "media-download",
      mediaId,
      mediaType,
      exp: Math.floor((now + PHOTO_DOWNLOAD_LIFETIME_MS) / 1000),
    } satisfies MediaTokenPayload, this.env.MEDIA_SECRET);
    const id = crypto.randomUUID();
    this.forNearbyPlayers(player, CHAT_RADIUS, PHOTO_RECIPIENT_LIMIT, recipient => {
      this.sendJson(recipient, {
        type: "photo",
        id,
        player: this.networkPlayer(player, 1, now),
        mediaId,
        mediaType,
        downloadToken,
        sentAt: now,
        durationMs: 12_000,
      });
    }, socket);
  }

  private forNearbyPlayers(
    source: SocketAttachment,
    radius: number,
    limit: number,
    callback: (socket: WebSocket) => void,
    include: WebSocket,
  ): void {
    const now = Date.now();
    const sourcePosition = this.project(source, now);
    const nearby: Array<{ socket: WebSocket; distanceSquared: number }> = [];
    for (const candidateSocket of this.ctx.getWebSockets()) {
      if (candidateSocket === include) continue;
      const candidate = this.readAttachment(candidateSocket);
      if (!candidate?.initialized) continue;
      if (hasBlockBetween(source, candidate)) continue;
      const position = this.project(candidate, now);
      const dx = position.x - sourcePosition.x;
      const dy = position.y - sourcePosition.y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared <= radius * radius) nearby.push({ socket: candidateSocket, distanceSquared });
    }
    nearby.sort((left, right) => left.distanceSquared - right.distanceSquared);
    callback(include);
    for (const candidate of nearby.slice(0, limit)) callback(candidate.socket);
  }

  private rememberPlayer(viewerSocket: WebSocket, player: SocketAttachment, zone: InterestZone, now: number): void {
    const viewer = this.readAttachment(viewerSocket);
    if (!viewer?.initialized || hasBlockBetween(viewer, player)) return;
    const known = this.ensureKnownMap(viewerSocket);
    known.set(player.slot, zone);
    let viewers = this.viewersByPlayer.get(player.slot);
    if (!viewers) {
      viewers = new Set();
      this.viewersByPlayer.set(player.slot, viewers);
    }
    viewers.add(viewerSocket);
    this.sendJson(viewerSocket, { type: "enter", player: this.networkPlayer(player, zone, now) });
  }

  private forgetPlayer(viewerSocket: WebSocket, slot: number): void {
    const known = this.knownByViewer.get(viewerSocket);
    if (!known?.delete(slot)) return;
    this.viewersByPlayer.get(slot)?.delete(viewerSocket);
    const playerSocket = this.socketsBySlot.get(slot);
    const player = playerSocket ? this.readAttachment(playerSocket) : null;
    this.sendJson(viewerSocket, { type: "leave", playerId: player?.playerId ?? "", slot });
  }

  private ensureKnownMap(socket: WebSocket): Map<number, InterestZone> {
    let known = this.knownByViewer.get(socket);
    if (!known) {
      known = new Map();
      this.knownByViewer.set(socket, known);
    }
    return known;
  }

  private networkPlayer(player: SocketAttachment, zone: InterestZone, now: number): NetworkPlayer {
    const position = this.project(player, now);
    return {
      id: player.playerId,
      authUserId: player.authUserId,
      slot: player.slot,
      username: player.username,
      color: player.color,
      x: position.x,
      y: position.y,
      velocityX: player.velocityX,
      velocityY: player.velocityY,
      sequence: player.sequence,
      updatedAt: now,
      zone,
      ...(this.circles.presenceFor(player.authUserId) ?? {}),
    };
  }

  private stateRecord(player: SocketAttachment, zone: InterestZone, now: number): StateRecord {
    const position = this.project(player, now);
    return {
      slot: player.slot,
      x: position.x,
      y: position.y,
      velocityX: player.velocityX,
      velocityY: player.velocityY,
      sequence: player.sequence,
      zone,
    };
  }

  private project(player: SocketAttachment, now: number): ProjectedPosition {
    const elapsedSeconds = clamp((now - player.updatedAt) / 1000, 0, 30);
    return {
      x: clamp(player.x + player.velocityX * elapsedSeconds, PLAYER_HALF_SIZE, WORLD_WIDTH - PLAYER_HALF_SIZE),
      y: clamp(player.y + player.velocityY * elapsedSeconds, PLAYER_HALF_SIZE, WORLD_HEIGHT - PLAYER_HALF_SIZE),
    };
  }

  private sendState(socket: WebSocket, player: SocketAttachment, zone: InterestZone, now: number): void {
    this.sendBinary(socket, encodeStateBatch(now, [this.stateRecord(player, zone, now)]));
  }

  private sendJson(socket: WebSocket, message: ServerControlMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.removeSocket(socket);
    }
  }

  private sendBinary(socket: WebSocket, message: ArrayBuffer): void {
    try {
      socket.send(message);
    } catch {
      this.removeSocket(socket);
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.sendJson(socket, { type: "error", code, message });
  }

  private broadcastCount(): void {
    const message: ServerControlMessage = { type: "count", onlineCount: this.onlineCount() };
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.readAttachment(socket);
      if (state?.initialized) this.sendJson(socket, message);
    }
  }

  private onlineCount(): number {
    let count = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (this.readAttachment(socket)?.initialized) count += 1;
    }
    return count;
  }

  private allocateSlot(): number {
    for (let attempt = 0; attempt < 0xffff; attempt += 1) {
      if (this.nextSlot < 1 || this.nextSlot > 0xffff) this.nextSlot = 1;
      const slot = this.nextSlot;
      this.nextSlot = this.nextSlot >= 0xffff ? 1 : this.nextSlot + 1;
      if (!this.socketsBySlot.has(slot)) return slot;
    }
    throw new Error("The room has no free player slots.");
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    try {
      return socket.deserializeAttachment() as SocketAttachment | null;
    } catch {
      return null;
    }
  }

  private socketForUser(userId: string): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.readAttachment(socket);
      if (attachment?.initialized && attachment.authUserId === userId) return socket;
    }
    return null;
  }

  private circleParticipant(userId: string): CircleParticipant | null {
    const socket = this.socketForUser(userId);
    const attachment = socket ? this.readAttachment(socket) : null;
    return attachment?.initialized ? this.circleParticipantFromAttachment(attachment) : null;
  }

  private circleParticipantFromAttachment(attachment: SocketAttachment): CircleParticipant {
    return {
      userId: attachment.authUserId,
      playerId: attachment.playerId,
      username: attachment.username,
      color: attachment.color,
      socialReady: attachment.socialReady === true,
    };
  }

  private async removeSocket(socket: WebSocket, broadcast = true, preserveCircle = false): Promise<void> {
    const attachment = this.readAttachment(socket);
    const shouldUpdateCircle = Boolean(attachment?.initialized && attachment.authUserId);
    const wasRegistered = Boolean(attachment?.initialized && this.socketsBySlot.has(attachment.slot));
    if (attachment?.initialized && wasRegistered) {
      const viewers = [...(this.viewersByPlayer.get(attachment.slot) ?? [])];
      for (const viewer of viewers) this.forgetPlayer(viewer, attachment.slot);
      this.viewersByPlayer.delete(attachment.slot);
      const known = this.knownByViewer.get(socket);
      if (known) {
        for (const slot of known.keys()) this.viewersByPlayer.get(slot)?.delete(socket);
      }
      this.socketsBySlot.delete(attachment.slot);
      for (const other of this.ctx.getWebSockets()) {
        if (other === socket || !this.readAttachment(other)?.initialized) continue;
        this.sendJson(other, { type: "leave", playerId: attachment.playerId, slot: attachment.slot });
      }
    }
    this.knownByViewer.delete(socket);
    this.lastFullReconcile.delete(socket);
    if (attachment?.initialized) {
      attachment.initialized = false;
      socket.serializeAttachment(attachment);
    }
    if (broadcast && wasRegistered) this.broadcastCount();
    if (shouldUpdateCircle && attachment?.authUserId) {
      await this.circles.removeParticipant(attachment.authUserId, preserveCircle);
    }
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason.slice(0, 120));
    } catch {
      // The peer may already be gone.
    }
  }
}

async function uploadTemporaryMedia(
  request: Request,
  env: Env,
  origin: string | null,
  mediaId: string,
): Promise<Response> {
  if (!env.MEDIA_SECRET || env.MEDIA_SECRET.length < 32) {
    return json({ error: "Temporary pictures are not configured." }, 503, origin, env);
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "The photo upload grant is missing." }, 401, origin, env);
  }
  const payload = await verifyMediaToken(authorization.slice(7), env.MEDIA_SECRET, "media-upload", mediaId);
  if (!payload?.sub || !isNearbyMediaType(payload.mediaType)) {
    return json({ error: "The photo upload grant is invalid or expired." }, 401, origin, env);
  }
  const expectedContentType = payload.mediaType === "gif" ? "image/gif" : "image/jpeg";
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== expectedContentType) {
    return json({ error: "The temporary media type does not match its grant." }, 415, origin, env);
  }

  const maximumBytes = payload.mediaType === "gif" ? MAX_TEMPORARY_GIF_BYTES : MAX_PHOTO_BYTES;
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return json({ error: "The temporary picture is too large." }, 413, origin, env);
  }
  const bytes = await request.arrayBuffer();
  const validBytes = payload.mediaType === "gif" ? isSafeGif(bytes) : isSafeJpeg(bytes, 1_024);
  if (bytes.byteLength <= 3 || bytes.byteLength > maximumBytes || !validBytes) {
    return json({ error: "The temporary picture has invalid contents or size." }, 400, origin, env);
  }

  const key = mediaKey(mediaId, payload.mediaType);
  const expiresAt = Date.now() + PHOTO_RETENTION_MS;
  const stored = await env.TEMPORARY_MEDIA.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: expectedContentType, cacheControl: "private, no-store" },
    customMetadata: { ownerId: payload.sub, mediaType: payload.mediaType, expiresAt: String(expiresAt) },
  });
  if (!stored) return json({ error: "That one-time photo upload was already used." }, 409, origin, env);
  return json({ mediaId, expiresAt }, 201, origin, env);
}

async function readTemporaryMedia(
  request: Request,
  env: Env,
  origin: string | null,
  mediaId: string,
): Promise<Response> {
  if (!env.MEDIA_SECRET || env.MEDIA_SECRET.length < 32) {
    return json({ error: "Temporary pictures are not configured." }, 503, origin, env);
  }
  const token = new URL(request.url).searchParams.get("token");
  const payload = token
    ? await verifyMediaToken(token, env.MEDIA_SECRET, "media-download", mediaId)
    : null;
  if (!payload || !isNearbyMediaType(payload.mediaType)) {
    return json({ error: "The temporary picture link is invalid or expired." }, 401, origin, env);
  }

  const key = mediaKey(mediaId, payload.mediaType);
  const object = await env.TEMPORARY_MEDIA.get(key);
  if (!object) return json({ error: "The temporary picture is gone." }, 404, origin, env);
  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await env.TEMPORARY_MEDIA.delete(key);
    return json({ error: "The temporary picture expired." }, 410, origin, env);
  }

  const headers = new Headers({
    "Content-Type": payload.mediaType === "gif" ? "image/gif" : "image/jpeg",
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (isAllowedOrigin(origin, env)) {
    for (const [keyName, value] of Object.entries(corsHeaders(origin))) headers.set(keyName, value);
  }
  return new Response(object.body, { status: 200, headers });
}

async function uploadSocialMedia(
  request: Request,
  env: Env,
  origin: string | null,
  postId: string,
): Promise<Response> {
  const authenticated = await authenticateRequest(request, env);
  if (authenticated instanceof Response) return withCors(authenticated, origin, env);
  const post = await findSocialPost(env, authenticated.accessToken, postId);
  if (!post
    || post.author_id !== authenticated.userId
    || !post.media_type
    || post.media_path !== socialMediaKey(post.author_id, post.id, post.media_type)) {
    return json({ error: "That social post is unavailable." }, 404, origin, env);
  }
  const expectedContentType = post.media_type === "gif" ? "image/gif" : "image/jpeg";
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== expectedContentType) {
    return json({ error: "The social media type does not match the post." }, 415, origin, env);
  }

  const maximumBytes = post.media_type === "gif" ? MAX_SOCIAL_GIF_BYTES : MAX_SOCIAL_MEDIA_BYTES;
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return json({ error: "The social picture is too large." }, 413, origin, env);
  }
  const bytes = await request.arrayBuffer();
  const validBytes = post.media_type === "gif" ? isSafeGif(bytes) : isSafeJpeg(bytes, 2_048);
  if (bytes.byteLength <= 3 || bytes.byteLength > maximumBytes || !validBytes) {
    return json({ error: "The social picture has invalid contents or size." }, 400, origin, env);
  }

  const expiresAt = post.pinned_to_home ? 0 : Date.parse(post.expires_at);
  if (!post.pinned_to_home && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    return json({ error: "That social post already expired." }, 410, origin, env);
  }
  const stored = await env.TEMPORARY_MEDIA.put(post.media_path, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: expectedContentType, cacheControl: "private, no-store" },
    customMetadata: {
      ownerId: authenticated.userId,
      postId,
      expiresAt: String(expiresAt),
    },
  });
  if (!stored) return json({ error: "That social picture was already uploaded." }, 409, origin, env);
  return json({ postId, expiresAt: expiresAt || null }, 201, origin, env);
}

async function readSocialMedia(
  request: Request,
  env: Env,
  origin: string | null,
  postId: string,
): Promise<Response> {
  const authenticated = await authenticateRequest(request, env);
  if (authenticated instanceof Response) return withCors(authenticated, origin, env);
  const post = await findSocialPost(env, authenticated.accessToken, postId);
  if (!post?.media_path
    || !post.media_type
    || post.media_path !== socialMediaKey(post.author_id, post.id, post.media_type)) {
    return json({ error: "That social picture is unavailable." }, 404, origin, env);
  }

  const object = await env.TEMPORARY_MEDIA.get(post.media_path);
  if (!object) return json({ error: "That social picture is unavailable." }, 404, origin, env);
  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    await env.TEMPORARY_MEDIA.delete(post.media_path);
    return json({ error: "That social picture expired." }, 410, origin, env);
  }
  const headers = new Headers({
    "Content-Type": post.media_type === "gif" ? "image/gif" : "image/jpeg",
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(object.body, { status: 200, headers });
}

async function deleteSocialMedia(
  request: Request,
  env: Env,
  origin: string | null,
  postId: string,
): Promise<Response> {
  const authenticated = await authenticateRequest(request, env);
  if (authenticated instanceof Response) return withCors(authenticated, origin, env);
  const post = await findSocialPost(env, authenticated.accessToken, postId);
  if (!post
    || post.author_id !== authenticated.userId
    || !post.media_type
    || post.media_path !== socialMediaKey(post.author_id, post.id, post.media_type)) {
    return json({ error: "That social picture is unavailable." }, 404, origin, env);
  }
  await env.TEMPORARY_MEDIA.delete(post.media_path);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

async function createIceServers(request: Request, env: Env, origin: string | null): Promise<Response> {
  const authenticated = await authenticateRequest(request, env);
  if (authenticated instanceof Response) return withCors(authenticated, origin, env);
  if (authenticated.isAnonymous
    || !await checkSocialReadyProfile(env, authenticated.accessToken, authenticated.userId)) {
    return json({ error: "Finish account setup before using Circle voice." }, 403, origin, env);
  }
  const stunOnly = {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    relayAvailable: false,
  };
  if (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_API_TOKEN) {
    return json(stunOnly, 200, origin, env);
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 14_400 }),
    },
  );
  if (!response.ok) {
    console.error("Cloudflare TURN credentials could not be generated", response.status);
    return json(stunOnly, 200, origin, env);
  }
  const result = await response.json<{ iceServers?: IceServerResponse[] }>();
  if (!Array.isArray(result.iceServers) || !result.iceServers.length) {
    return json(stunOnly, 200, origin, env);
  }
  const iceServers = result.iceServers.map(server => ({
    ...server,
    urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter(url => typeof url === "string" && !/:(?:53)(?:\?|$)/.test(url)),
  })).filter(server => server.urls.length);
  return json({ iceServers, relayAvailable: iceServers.some(server => server.urls.some(url => url.startsWith("turn"))) }, 200, origin, env);
}

async function deleteAccount(request: Request, env: Env, origin: string | null): Promise<Response> {
  const authenticated = await authenticateRequest(request, env);
  if (authenticated instanceof Response) return withCors(authenticated, origin, env);
  if (authenticated.isAnonymous) return json({ error: "Guest blocks do not have a permanent account to delete." }, 400, origin, env);
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 1_024) {
    return json({ error: "The deletion request is too large." }, 413, origin, env);
  }
  const body = await request.json<{ confirmation?: string }>().catch(() => null);
  if (body?.confirmation !== "DELETE") return json({ error: "Account deletion was not confirmed." }, 400, origin, env);

  const mediaPaths = await listOwnedSocialMedia(env, authenticated.accessToken, authenticated.userId);
  if (mediaPaths === null) return json({ error: "Private media could not be prepared for deletion." }, 502, origin, env);
  for (let index = 0; index < mediaPaths.length; index += 1_000) {
    await env.TEMPORARY_MEDIA.delete(mediaPaths.slice(index, index + 1_000));
  }

  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${authenticated.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  if (!response.ok) {
    console.error("Blockaroo account deletion RPC failed", response.status);
    return json({ error: "The account database record could not be deleted." }, 502, origin, env);
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

async function listOwnedSocialMedia(env: Env, accessToken: string, userId: string): Promise<string[] | null> {
  const paths: string[] = [];
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/social_posts`);
    url.searchParams.set("author_id", `eq.${userId}`);
    url.searchParams.set("media_path", "not.is.null");
    url.searchParams.set("select", "media_path");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(page * 1_000));
    const response = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const rows = await response.json<Array<{ media_path?: string | null }>>();
    for (const row of rows) {
      if (row.media_path?.startsWith(`${SOCIAL_MEDIA_PREFIX}${userId}/`)) paths.push(row.media_path);
    }
    if (rows.length < 1_000) return paths;
  }
  return null;
}

async function findSocialPost(env: Env, accessToken: string, postId: string): Promise<SocialPostRow | null> {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/social_posts`);
  url.searchParams.set("id", `eq.${postId}`);
  url.searchParams.set("select", "id,author_id,media_path,media_type,pinned_to_home,expires_at");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const rows = await response.json<SocialPostRow[]>();
  return rows[0] ?? null;
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthenticatedRequest | Response> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing Supabase session." }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const accessToken = authorization.slice(7);
  const authResponse = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: authorization,
    },
  });
  if (!authResponse.ok) {
    return new Response(JSON.stringify({ error: "Supabase session is not valid." }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const user = await authResponse.json<{ id?: string; is_anonymous?: boolean }>();
  if (!user.id) {
    return new Response(JSON.stringify({ error: "Supabase user was not returned." }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return { userId: user.id, accessToken, isAnonymous: user.is_anonymous !== false };
}

async function cleanupExpiredMedia(env: Env): Promise<void> {
  await cleanupExpiredMediaPrefix(env, MEDIA_PREFIX);
  await cleanupExpiredMediaPrefix(env, SOCIAL_MEDIA_PREFIX);
}

async function cleanupExpiredMediaPrefix(env: Env, prefix: string): Promise<void> {
  const now = Date.now();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await env.TEMPORARY_MEDIA.list({
      prefix,
      cursor,
      limit: 1_000,
      include: ["customMetadata"],
    });
    const expiredKeys = result.objects
      .filter(object => {
        const expiresAt = Number(object.customMetadata?.expiresAt || 0);
        return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
      })
      .map(object => object.key);
    if (expiredKeys.length) await env.TEMPORARY_MEDIA.delete(expiredKeys);
    if (!result.truncated) return;
    cursor = result.cursor;
  }
}

function mediaKey(mediaId: string, mediaType: NearbyMediaType): string {
  return `${MEDIA_PREFIX}${mediaId}.${mediaType === "gif" ? "gif" : "jpg"}`;
}

function socialMediaKey(authorId: string, postId: string, mediaType: "image" | "gif"): string {
  return `${SOCIAL_MEDIA_PREFIX}${authorId}/${postId}.${mediaType === "gif" ? "gif" : "jpg"}`;
}

function isJpeg(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isSafeJpeg(buffer: ArrayBuffer, maxDimension: number): boolean {
  if (!isJpeg(buffer)) return false;
  const bytes = new Uint8Array(buffer);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (length < 7) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 && width <= maxDimension && height <= maxDimension;
    }
    offset += length;
  }
  return false;
}

function isGif(buffer: ArrayBuffer): boolean {
  const header = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 6));
  return header === "GIF87a" || header === "GIF89a";
}

function isSafeGif(buffer: ArrayBuffer): boolean {
  if (!isGif(buffer)) return false;
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10) return false;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return width > 0 && height > 0 && width <= 1_024 && height <= 1_024;
}

function isNearbyMediaType(value: unknown): value is NearbyMediaType {
  return value === "image" || value === "gif";
}

async function createSocketSession(request: Request, env: Env, origin: string | null): Promise<Response> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing Supabase session." }, 401, origin, env);
  if (!env.TICKET_SECRET || env.TICKET_SECRET.length < 32) {
    console.error("TICKET_SECRET must contain at least 32 characters.");
    return json({ error: "World service is not configured." }, 503, origin, env);
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 1_024) {
    return json({ error: "The world session request is too large." }, 413, origin, env);
  }
  const body = await request.json<{ cityId?: unknown; spaceId?: unknown }>().catch(() => null);
  const cityId = typeof body?.cityId === "string" ? body.cityId.trim().toLowerCase() : "";
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim().toLowerCase() : "";
  if (cityId !== ACTIVE_CITY_ID || spaceId !== ACTIVE_SPACE_ID) {
    return json({ error: "That Blockaroo space is not available." }, 404, origin, env);
  }

  const authResponse = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: authorization,
    },
  });
  if (!authResponse.ok) return json({ error: "Supabase session is not valid." }, 401, origin, env);
  const user = await authResponse.json<{ id?: string; is_anonymous?: boolean }>();
  if (!user.id) return json({ error: "Supabase user was not returned." }, 401, origin, env);
  const accessToken = authorization.slice(7);
  const [socialReady, blockedUserIds] = await Promise.all([
    user.is_anonymous === false ? checkSocialReadyProfile(env, accessToken, user.id) : Promise.resolve(false),
    user.is_anonymous === false ? loadBlockedUserIds(env, accessToken, user.id) : Promise.resolve([]),
  ]);
  if (blockedUserIds === null) {
    return json({ error: "Your safety settings could not be loaded. Try again." }, 503, origin, env);
  }

  const payload: TicketPayload = {
    sub: user.id,
    exp: Math.floor(Date.now() / 1000) + TICKET_LIFETIME_SECONDS,
    nonce: crypto.randomUUID(),
    cityId,
    spaceId,
    anonymous: user.is_anonymous !== false,
    socialReady,
    blockedUserIds,
  };
  const ticket = await signTicket(payload, env.TICKET_SECRET);
  return json({ ticket, expiresAt: payload.exp * 1000 }, 200, origin, env);
}

async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  return signPayload(payload, secret);
}

async function verifyTicket(ticket: string, secret: string): Promise<TicketPayload | null> {
  const payload = await verifySignedPayload(ticket, secret) as Partial<TicketPayload> | null;
  if (!payload
    || typeof payload.sub !== "string"
    || typeof payload.exp !== "number"
    || !Number.isFinite(payload.exp)
    || payload.cityId !== ACTIVE_CITY_ID
    || payload.spaceId !== ACTIVE_SPACE_ID
    || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return {
    sub: payload.sub,
    exp: payload.exp,
    nonce: typeof payload.nonce === "string" ? payload.nonce : "",
    cityId: payload.cityId,
    spaceId: payload.spaceId,
    anonymous: payload.anonymous !== false,
    socialReady: payload.socialReady === true,
    blockedUserIds: Array.isArray(payload.blockedUserIds)
      ? payload.blockedUserIds.filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)).slice(0, 200)
      : [],
  };
}

async function checkSocialReadyProfile(env: Env, accessToken: string, userId: string): Promise<boolean> {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/profiles`);
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("select", "terms_accepted_at,age_confirmed_at,terms_version");
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return false;
  const rows = await response.json<Array<{
    terms_accepted_at?: string | null;
    age_confirmed_at?: string | null;
    terms_version?: string | null;
  }>>();
  const profile = rows[0];
  return Boolean(
    profile?.terms_accepted_at
    && profile.age_confirmed_at
    && profile.terms_version === "2026-07",
  );
}

async function loadBlockedUserIds(env: Env, accessToken: string, userId: string): Promise<string[] | null> {
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/user_blocks`);
  url.searchParams.set("blocker_id", `eq.${userId}`);
  url.searchParams.set("select", "blocked_id");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "200");
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const rows = await response.json<Array<{ blocked_id?: string }>>();
  return rows.flatMap(row => typeof row.blocked_id === "string" ? [row.blocked_id] : []);
}

async function verifyMediaToken(
  token: string,
  secret: string,
  kind: MediaTokenPayload["kind"],
  mediaId: string,
): Promise<MediaTokenPayload | null> {
  const payload = await verifySignedPayload(token, secret) as Partial<MediaTokenPayload> | null;
  if (!payload
    || payload.kind !== kind
    || payload.mediaId !== mediaId
    || typeof payload.exp !== "number"
    || !Number.isFinite(payload.exp)
    || payload.exp < Math.floor(Date.now() / 1000)
    || (payload.sub !== undefined && typeof payload.sub !== "string")) return null;
  return payload as MediaTokenPayload;
}

async function signPayload(payload: object, secret: string): Promise<string> {
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifySignedPayload(token: string, secret: string): Promise<object | null> {
  if (!secret || secret.length < 32) return null;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encodedPayload))) as unknown;
    return payload !== null && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function corsPreflight(origin: string | null, env: Env): Response {
  if (!isAllowedOrigin(origin, env)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

function json(body: unknown, status: number, origin: string | null, env: Env): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (isAllowedOrigin(origin, env)) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(response: Response, origin: string | null, env: Env): Response {
  if (!isAllowedOrigin(origin, env)) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isAllowedOrigin(origin: string | null, env: Env): boolean {
  if (!origin) return true;
  const allowed = env.ALLOWED_ORIGINS.split(",").map(value => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function cleanUsername(value: unknown): string {
  if (typeof value !== "string") return "New Neighbor";
  return value.trim().replace(/\s+/g, " ").slice(0, PROFILE_NAME_LENGTH) || "New Neighbor";
}

function cleanColor(value: unknown): string {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value.toLowerCase() : "#ff6b6b";
}

function isNewerSequence(next: number, previous: number): boolean {
  const difference = (next - previous) & 0xffff;
  return difference > 0 && difference < 0x8000;
}

function countZone(known: Map<number, InterestZone>, zone: InterestZone): number {
  let count = 0;
  for (const value of known.values()) if (value === zone) count += 1;
  return count;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
