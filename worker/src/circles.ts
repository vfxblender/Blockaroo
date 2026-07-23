import type {
  CircleGame,
  CircleMode,
  CircleSignalData,
  CircleState,
  ClientControlMessage,
  NetworkPlayer,
  ServerControlMessage,
} from "../../shared/worldProtocol";
import {
  applyCircleGameAction,
  circleGameLabel,
  circleGameSnapshot,
  createCircleGame,
  type StoredCircleGameState,
  validateGamePlayers,
} from "./circleGames.ts";

export interface CircleParticipant {
  userId: string;
  playerId: string;
  username: string;
  color: string;
  socialReady: boolean;
}

export interface CircleRoomAdapter {
  participant(userId: string): CircleParticipant | null;
  networkPlayer(userId: string): NetworkPlayer | null;
  send(userId: string, message: ServerControlMessage): void;
  publishPresence(userId: string): void;
  blockedBetween(firstUserId: string, secondUserId: string): boolean;
}

interface CircleRecord {
  id: string;
  hostId: string;
  mode: CircleMode;
  memberIds: string[];
  joinedAt: Record<string, number>;
  muted: Record<string, boolean>;
  disconnectedAt: Record<string, number>;
  game: CircleGame | null;
  gameState: StoredCircleGameState | null;
  revision: number;
  createdAt: number;
  loneSince: number | null;
  pendingRequestIds: string[];
  centerX: number;
  centerY: number;
}

interface CircleInvitation {
  id: string;
  inviterId: string;
  targetId: string;
  circleId: string | null;
  mode: CircleMode;
  expiresAt: number;
}

const CIRCLES_STORAGE_KEY = "social-circles";
const INVITATIONS_STORAGE_KEY = "social-circle-invitations";
const DRAWING_STORAGE_PREFIX = "social-circle-drawing:";
const CIRCLE_LIMIT = 6;
const INVITATION_LIFETIME_MS = 30_000;
const RECONNECT_GRACE_MS = 15_000;
const LONE_CIRCLE_LIFETIME_MS = 10_000;
const CIRCLE_JOIN_RADIUS = 220;
const CIRCLE_LEAVE_RADIUS = 300;

export class CircleCoordinator {
  private readonly circles = new Map<string, CircleRecord>();
  private readonly invitations = new Map<string, CircleInvitation>();
  private readonly persistedDrawingKeys = new Set<string>();
  private readonly lastGameActionAt = new Map<string, number>();
  private readonly signalWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly ctx: DurableObjectState;
  private readonly adapter: CircleRoomAdapter;

  constructor(ctx: DurableObjectState, adapter: CircleRoomAdapter) {
    this.ctx = ctx;
    this.adapter = adapter;
    this.ctx.blockConcurrencyWhile(async () => {
      const [storedCircles, storedInvitations] = await Promise.all([
        this.ctx.storage.get<CircleRecord[]>(CIRCLES_STORAGE_KEY),
        this.ctx.storage.get<CircleInvitation[]>(INVITATIONS_STORAGE_KEY),
      ]);
      const restoredCircles = storedCircles ?? [];
      const storedDrawings = await Promise.all(restoredCircles.map(async circle => {
        if (circle.gameState?.kind !== "draw") return null;
        const key = drawingStorageKey(circle.id);
        const strokes = await this.ctx.storage.get<DrawStrokes>(key);
        this.persistedDrawingKeys.add(key);
        return { circleId: circle.id, strokes };
      }));
      const drawingByCircle = new Map(storedDrawings.flatMap(drawing => (
        drawing?.strokes ? [[drawing.circleId, drawing.strokes] as const] : []
      )));
      for (const circle of restoredCircles) {
        circle.disconnectedAt ??= {};
        if (!Number.isFinite(circle.centerX) || !Number.isFinite(circle.centerY)) {
          const center = this.centerFor(circle.memberIds);
          circle.centerX = center.x;
          circle.centerY = center.y;
        }
        if (circle.gameState?.kind === "draw") {
          circle.gameState.strokes = drawingByCircle.get(circle.id) ?? circle.gameState.strokes;
        }
        this.circles.set(circle.id, circle);
      }
      for (const invitation of storedInvitations ?? []) this.invitations.set(invitation.id, invitation);
      await this.cleanup(Date.now());
    });
  }

  async handle(participant: CircleParticipant, message: ClientControlMessage): Promise<boolean> {
    if (message.type === "circle-invite") {
      await this.invite(participant, message.targetPlayerId, message.mode);
      return true;
    }
    if (message.type === "circle-invite-response") {
      await this.respondToInvite(participant, message.invitationId, message.accept);
      return true;
    }
    if (message.type === "circle-join-request") {
      await this.requestJoin(participant, message.circleId);
      return true;
    }
    if (message.type === "circle-join-response") {
      await this.respondToJoinRequest(participant, message.requesterPlayerId, message.accept);
      return true;
    }
    if (message.type === "circle-leave") {
      await this.leave(participant.userId, "You left the Circle.");
      return true;
    }
    if (message.type === "circle-mode") {
      await this.setMode(participant, message.mode);
      return true;
    }
    if (message.type === "circle-kick") {
      await this.kick(participant, message.targetPlayerId);
      return true;
    }
    if (message.type === "circle-voice-state") {
      await this.setVoiceState(participant, message.muted);
      return true;
    }
    if (message.type === "circle-signal") {
      this.forwardSignal(participant, message.targetPlayerId, message.signal);
      return true;
    }
    if (message.type === "circle-game-start") {
      await this.startGame(participant, message.game);
      return true;
    }
    if (message.type === "circle-game-end") {
      await this.stopGame(participant);
      return true;
    }
    if (message.type === "circle-game-action") {
      await this.gameAction(participant, message.action, message.payload);
      return true;
    }
    return false;
  }

  async restoreParticipant(userId: string): Promise<void> {
    const circle = this.circleForUser(userId);
    if (!circle) return;
    if (circle.disconnectedAt[userId]) {
      delete circle.disconnectedAt[userId];
      circle.revision += 1;
      await this.persist();
      this.broadcastCircle(circle);
      return;
    }
    this.sendCircleState(circle, userId);
  }

  refreshParticipant(userId: string): void {
    const circle = this.circleForUser(userId);
    if (circle) this.broadcastCircle(circle);
  }

  async removeParticipant(userId: string, preserveMembership = false): Promise<void> {
    if (preserveMembership) {
      const circle = this.circleForUser(userId);
      if (circle) {
        circle.disconnectedAt[userId] ??= Date.now();
        await this.persist();
      }
      return;
    }
    for (const [id, invitation] of this.invitations) {
      if (invitation.inviterId === userId || invitation.targetId === userId) this.invitations.delete(id);
    }
    const circle = this.circleForUser(userId);
    if (circle) await this.removeMember(circle, userId, "Connection closed.");
    else await this.persist();
  }

  presenceFor(userId: string): Pick<NetworkPlayer, "circleId" | "circleMode" | "circleCount" | "activity"> | null {
    const circle = this.circleForUser(userId);
    if (!circle) return null;
    return {
      circleId: circle.id,
      circleMode: circle.mode,
      circleCount: circle.memberIds.length,
      activity: circle.game ? `Playing ${circleGameLabel(circle.game)}` : "Talking in a Circle",
    };
  }

  async alarm(): Promise<void> {
    await this.cleanup(Date.now());
  }

  async checkPosition(userId: string, x: number, y: number): Promise<void> {
    const circle = this.circleForUser(userId);
    if (!circle || distanceSquared(x, y, circle.centerX, circle.centerY) <= CIRCLE_LEAVE_RADIUS ** 2) return;
    this.adapter.send(userId, {
      type: "circle-closed",
      circleId: circle.id,
      reason: "You walked away from the Circle.",
    });
    await this.removeMember(circle, userId, "A member walked away.");
  }

  private async invite(participant: CircleParticipant, targetPlayerId: string, rawMode: CircleMode): Promise<void> {
    if (!this.requirePermanent(participant)) return;
    const mode = isCircleMode(rawMode) ? rawMode : "request";
    const target = this.adapter.participant(targetPlayerId);
    if (!target || target.userId === participant.userId) return this.error(participant.userId, "circle_target", "Choose another nearby player.");
    if (this.adapter.blockedBetween(participant.userId, target.userId)) {
      return this.error(participant.userId, "circle_blocked", "That connection is unavailable.");
    }
    if (!target.socialReady) return this.error(participant.userId, "circle_account", "That player needs to finish account setup before joining a Circle.");
    if (this.circleForUser(target.userId)) return this.error(participant.userId, "circle_busy", "That player is already in a Circle.");

    const existingCircle = this.circleForUser(participant.userId);
    if (existingCircle && existingCircle.hostId !== participant.userId) {
      return this.error(participant.userId, "circle_host_only", "Only the Circle host can invite players.");
    }
    if (existingCircle?.game) {
      return this.error(participant.userId, "circle_game_locked", "Finish the current game before inviting another player.");
    }
    if (existingCircle && existingCircle.memberIds.length >= CIRCLE_LIMIT) {
      return this.error(participant.userId, "circle_full", "This Circle already has six members.");
    }
    const participantPosition = this.adapter.networkPlayer(participant.userId);
    const targetPosition = this.adapter.networkPlayer(target.userId);
    const nearEnough = existingCircle
      ? targetPosition && this.insideJoinRadius(existingCircle, targetPosition)
      : participantPosition && targetPosition
        && distanceSquared(participantPosition.x, participantPosition.y, targetPosition.x, targetPosition.y) <= CIRCLE_JOIN_RADIUS ** 2;
    if (!nearEnough) return this.error(participant.userId, "circle_too_far", "Move closer before inviting that player.");

    for (const [id, invitation] of this.invitations) {
      if (invitation.targetId === target.userId && invitation.inviterId === participant.userId) this.invitations.delete(id);
    }
    const invitation: CircleInvitation = {
      id: crypto.randomUUID(),
      inviterId: participant.userId,
      targetId: target.userId,
      circleId: existingCircle?.id ?? null,
      mode: existingCircle?.mode ?? mode,
      expiresAt: Date.now() + INVITATION_LIFETIME_MS,
    };
    this.invitations.set(invitation.id, invitation);
    const fromPlayer = this.adapter.networkPlayer(participant.userId);
    if (!fromPlayer) return;
    this.adapter.send(target.userId, {
      type: "circle-invite",
      invitationId: invitation.id,
      fromPlayer,
      circleId: invitation.circleId,
      mode: invitation.mode,
      expiresAt: invitation.expiresAt,
    });
    this.notice(participant.userId, `Circle invitation sent to ${target.username}.`);
    await this.persist();
  }

  private async respondToInvite(participant: CircleParticipant, invitationId: string, accept: boolean): Promise<void> {
    if (!this.requirePermanent(participant)) return;
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.targetId !== participant.userId || invitation.expiresAt <= Date.now()) {
      return this.error(participant.userId, "circle_invite_missing", "That Circle invitation expired.");
    }
    this.invitations.delete(invitationId);
    if (!accept) {
      this.notice(invitation.inviterId, `${participant.username} declined the Circle invitation.`);
      return this.persist();
    }
    if (this.circleForUser(participant.userId)) {
      return this.error(participant.userId, "circle_busy", "Leave your current Circle first.");
    }

    const inviter = this.adapter.participant(invitation.inviterId);
    if (!inviter) return this.error(participant.userId, "circle_inviter_left", "The player who invited you left.");
    if (this.adapter.blockedBetween(participant.userId, invitation.inviterId)) {
      return this.error(participant.userId, "circle_blocked", "That connection is unavailable.");
    }
    let circle = invitation.circleId ? this.circles.get(invitation.circleId) ?? null : null;
    if (circle) {
      if (circle.game) return this.error(participant.userId, "circle_game_locked", "That Circle is playing. Join after the round.");
      if (circle.memberIds.length >= CIRCLE_LIMIT) return this.error(participant.userId, "circle_full", "That Circle filled up.");
      if (!circle.memberIds.includes(invitation.inviterId)) return this.error(participant.userId, "circle_inviter_left", "The inviter left that Circle.");
      const position = this.adapter.networkPlayer(participant.userId);
      if (!position || !this.insideJoinRadius(circle, position)) {
        return this.error(participant.userId, "circle_too_far", "Move back near the Circle before joining.");
      }
      await this.addMember(circle, participant.userId);
      return;
    }
    if (this.circleForUser(invitation.inviterId)) {
      return this.error(participant.userId, "circle_changed", "That player joined a different Circle.");
    }
    const inviterPosition = this.adapter.networkPlayer(invitation.inviterId);
    const participantPosition = this.adapter.networkPlayer(participant.userId);
    if (!inviterPosition || !participantPosition
      || distanceSquared(inviterPosition.x, inviterPosition.y, participantPosition.x, participantPosition.y) > CIRCLE_JOIN_RADIUS ** 2) {
      return this.error(participant.userId, "circle_too_far", "Move back near the inviter before joining.");
    }

    const now = Date.now();
    const centerX = (inviterPosition.x + participantPosition.x) / 2;
    const centerY = (inviterPosition.y + participantPosition.y) / 2;
    circle = {
      id: crypto.randomUUID(),
      hostId: invitation.inviterId,
      mode: invitation.mode,
      memberIds: [invitation.inviterId, participant.userId],
      joinedAt: { [invitation.inviterId]: now, [participant.userId]: now + 1 },
      muted: { [invitation.inviterId]: false, [participant.userId]: false },
      disconnectedAt: {},
      game: null,
      gameState: null,
      revision: 1,
      createdAt: now,
      loneSince: null,
      pendingRequestIds: [],
      centerX,
      centerY,
    };
    this.circles.set(circle.id, circle);
    await this.persist();
    this.broadcastCircle(circle);
  }

  private async requestJoin(participant: CircleParticipant, circleId: string): Promise<void> {
    if (!this.requirePermanent(participant)) return;
    if (this.circleForUser(participant.userId)) return this.error(participant.userId, "circle_busy", "Leave your current Circle first.");
    const circle = this.circles.get(circleId);
    if (!circle) return this.error(participant.userId, "circle_missing", "That Circle has closed.");
    if (circle.game) return this.error(participant.userId, "circle_game_locked", "That Circle is playing. Ask again after the round.");
    if (circle.memberIds.length >= CIRCLE_LIMIT) return this.error(participant.userId, "circle_full", "That Circle is full.");
    if (circle.mode === "invite") return this.error(participant.userId, "circle_private", "That Circle is invite only.");
    if (!this.canJoinCircle(participant.userId, circle)) {
      return this.error(participant.userId, "circle_blocked", "That Circle includes an unavailable connection.");
    }
    const position = this.adapter.networkPlayer(participant.userId);
    if (!position || !this.insideJoinRadius(circle, position)) {
      return this.error(participant.userId, "circle_too_far", "Move closer before asking to join.");
    }
    if (circle.mode === "open") return this.addMember(circle, participant.userId);
    if (!circle.pendingRequestIds.includes(participant.userId)) circle.pendingRequestIds.push(participant.userId);
    const requester = this.adapter.networkPlayer(participant.userId);
    if (requester) {
      this.adapter.send(circle.hostId, { type: "circle-join-request", requester, circleId: circle.id });
      this.notice(participant.userId, "Ask-to-join sent to the Circle host.");
    }
    await this.persist();
  }

  private async respondToJoinRequest(participant: CircleParticipant, requesterId: string, accept: boolean): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle || circle.hostId !== participant.userId) return this.error(participant.userId, "circle_host_only", "Only the host can answer join requests.");
    if (!circle.pendingRequestIds.includes(requesterId)) return this.error(participant.userId, "circle_request_missing", "That request is no longer active.");
    circle.pendingRequestIds = circle.pendingRequestIds.filter(id => id !== requesterId);
    const requester = this.adapter.participant(requesterId);
    if (!accept) {
      if (requester) this.notice(requesterId, "The Circle host declined your request.");
      return this.persist();
    }
    if (!requester || !requester.socialReady) return this.error(participant.userId, "circle_requester_left", "That player is no longer available.");
    if (this.circleForUser(requesterId)) return this.error(participant.userId, "circle_requester_busy", "That player joined another Circle.");
    await this.addMember(circle, requesterId);
  }

  private async addMember(circle: CircleRecord, userId: string): Promise<void> {
    if (circle.game) return this.error(userId, "circle_game_locked", "That Circle is playing. Join after the round.");
    if (circle.memberIds.length >= CIRCLE_LIMIT) return this.error(userId, "circle_full", "That Circle is full.");
    if (!this.canJoinCircle(userId, circle)) {
      return this.error(userId, "circle_blocked", "That Circle includes an unavailable connection.");
    }
    const position = this.adapter.networkPlayer(userId);
    if (!position || !this.insideJoinRadius(circle, position)) {
      return this.error(userId, "circle_too_far", "Move closer before joining that Circle.");
    }
    circle.memberIds.push(userId);
    circle.joinedAt[userId] = Date.now();
    circle.muted[userId] = false;
    circle.loneSince = null;
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
  }

  private async leave(userId: string, reason: string): Promise<void> {
    const circle = this.circleForUser(userId);
    if (!circle) return;
    this.adapter.send(userId, { type: "circle-closed", circleId: circle.id, reason });
    await this.removeMember(circle, userId, reason);
  }

  private async kick(participant: CircleParticipant, targetId: string): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle || circle.hostId !== participant.userId) return this.error(participant.userId, "circle_host_only", "Only the host can remove a member.");
    if (targetId === participant.userId) return this.error(participant.userId, "circle_kick_self", "Use Leave Circle instead.");
    if (!circle.memberIds.includes(targetId)) return;
    this.adapter.send(targetId, { type: "circle-closed", circleId: circle.id, reason: "The host removed you from the Circle." });
    await this.removeMember(circle, targetId, "A member was removed.");
  }

  private async removeMember(circle: CircleRecord, userId: string, reason: string): Promise<void> {
    circle.memberIds = circle.memberIds.filter(id => id !== userId);
    circle.pendingRequestIds = circle.pendingRequestIds.filter(id => id !== userId);
    delete circle.joinedAt[userId];
    delete circle.muted[userId];
    delete circle.disconnectedAt[userId];
    this.clearRateState(userId);
    this.adapter.publishPresence(userId);
    if (circle.game) this.endGame(circle, "The game ended when Circle membership changed.");
    if (!circle.memberIds.length) {
      this.circles.delete(circle.id);
      await this.persist();
      return;
    }
    if (circle.hostId === userId) {
      circle.hostId = [...circle.memberIds].sort((a, b) => (circle.joinedAt[a] ?? 0) - (circle.joinedAt[b] ?? 0))[0]!;
    }
    circle.loneSince = circle.memberIds.length === 1 ? Date.now() : null;
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
    if (circle.memberIds.length === 1) this.notice(circle.memberIds[0], `${reason} This Circle closes in 10 seconds if nobody joins.`);
  }

  private async setMode(participant: CircleParticipant, mode: CircleMode): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle || circle.hostId !== participant.userId) return this.error(participant.userId, "circle_host_only", "Only the host can change Circle access.");
    if (!isCircleMode(mode)) return;
    circle.mode = mode;
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
  }

  private async setVoiceState(participant: CircleParticipant, muted: boolean): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle) return;
    circle.muted[participant.userId] = Boolean(muted);
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
  }

  private forwardSignal(participant: CircleParticipant, targetId: string, signal: CircleSignalData): void {
    const circle = this.circleForUser(participant.userId);
    if (!circle
      || !circle.memberIds.includes(targetId)
      || this.adapter.blockedBetween(participant.userId, targetId)
      || !validSignal(signal)) return;
    const now = Date.now();
    const window = this.signalWindows.get(participant.userId);
    if (!window || now - window.startedAt >= 10_000) {
      this.signalWindows.set(participant.userId, { startedAt: now, count: 1 });
    } else {
      if (window.count >= 120) return;
      window.count += 1;
    }
    this.adapter.send(targetId, { type: "circle-signal", fromPlayerId: participant.playerId, signal });
  }

  private async startGame(participant: CircleParticipant, game: CircleGame): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle || circle.hostId !== participant.userId) return this.error(participant.userId, "circle_host_only", "Only the host can start a game.");
    if (!isCircleGame(game)) return;
    const validationError = validateGamePlayers(game, circle.memberIds.length);
    if (validationError) return this.error(participant.userId, "circle_game_players", validationError);
    circle.game = game;
    circle.gameState = createCircleGame(game, circle.memberIds);
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
  }

  private async stopGame(participant: CircleParticipant): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle || circle.hostId !== participant.userId) return this.error(participant.userId, "circle_host_only", "Only the host can end a game.");
    if (!circle.game) return;
    this.endGame(circle, "The host returned the Circle to the game picker.");
    circle.revision += 1;
    await this.persist();
    this.broadcastCircle(circle);
  }

  private async gameAction(participant: CircleParticipant, action: string, payload: unknown): Promise<void> {
    const circle = this.circleForUser(participant.userId);
    if (!circle?.gameState) return this.error(participant.userId, "circle_game_missing", "Start a Circle game first.");
    const cleanAction = typeof action === "string" ? action.trim().slice(0, 32) : "";
    const rateKey = `${participant.userId}:${circle.game}:${cleanAction}`;
    const now = Date.now();
    const minimumInterval = cleanAction === "stroke" ? 20 : cleanAction === "move" ? 80 : 120;
    if (now - (this.lastGameActionAt.get(rateKey) ?? 0) < minimumInterval) return;
    this.lastGameActionAt.set(rateKey, now);
    const error = applyCircleGameAction(circle.gameState, participant.userId, circle.hostId, cleanAction, payload);
    if (error) return this.error(participant.userId, "circle_game_action", error);
    circle.revision += 1;
    const highFrequencyAction = (circle.game === "draw" && cleanAction === "stroke")
      || (circle.game === "square-off" && cleanAction === "move");
    if (!highFrequencyAction || circle.gameState.phase !== "playing" || circle.gameState.revision % 12 === 0) {
      await this.persist();
    }
    this.broadcastGame(circle, circle.game === "draw" && cleanAction === "stroke");
    for (const memberId of circle.memberIds) this.adapter.publishPresence(memberId);
  }

  private endGame(circle: CircleRecord, message: string): void {
    circle.game = null;
    circle.gameState = null;
    for (const memberId of circle.memberIds) this.notice(memberId, message);
  }

  private broadcastCircle(circle: CircleRecord): void {
    for (const memberId of circle.memberIds) this.sendCircleState(circle, memberId);
    for (const memberId of circle.memberIds) this.adapter.publishPresence(memberId);
  }

  private sendCircleState(circle: CircleRecord, memberId: string): void {
    this.adapter.send(memberId, { type: "circle-state", circle: this.publicCircle(circle) });
    if (circle.gameState) {
      this.adapter.send(memberId, {
        type: "circle-game-state",
        circleId: circle.id,
        snapshot: circleGameSnapshot(circle.gameState, memberId),
      });
    }
  }

  private broadcastGame(circle: CircleRecord, drawingDelta = false): void {
    if (!circle.gameState) return;
    for (const memberId of circle.memberIds) {
      this.adapter.send(memberId, {
        type: "circle-game-state",
        circleId: circle.id,
        snapshot: circleGameSnapshot(circle.gameState, memberId, drawingDelta),
      });
    }
  }

  private publicCircle(circle: CircleRecord): CircleState {
    return {
      id: circle.id,
      hostPlayerId: circle.hostId,
      mode: circle.mode,
      members: circle.memberIds.flatMap(userId => {
        const participant = this.adapter.participant(userId);
        return participant ? [{
          playerId: participant.playerId,
          authUserId: participant.userId,
          username: participant.username,
          color: participant.color,
          isHost: circle.hostId === userId,
          isMuted: Boolean(circle.muted[userId]),
        }] : [];
      }),
      game: circle.game,
      activity: circle.game ? `Playing ${circleGameLabel(circle.game)}` : "Talking",
      revision: circle.revision,
      createdAt: circle.createdAt,
    };
  }

  private circleForUser(userId: string): CircleRecord | null {
    for (const circle of this.circles.values()) {
      if (circle.memberIds.includes(userId)) return circle;
    }
    return null;
  }

  private insideJoinRadius(circle: CircleRecord, player: NetworkPlayer): boolean {
    return distanceSquared(player.x, player.y, circle.centerX, circle.centerY) <= CIRCLE_JOIN_RADIUS ** 2;
  }

  private canJoinCircle(userId: string, circle: CircleRecord): boolean {
    return circle.memberIds.every(memberId => !this.adapter.blockedBetween(userId, memberId));
  }

  private centerFor(memberIds: string[]): { x: number; y: number } {
    const positions = memberIds.flatMap(userId => {
      const player = this.adapter.networkPlayer(userId);
      return player ? [{ x: player.x, y: player.y }] : [];
    });
    if (!positions.length) return { x: 0, y: 0 };
    return {
      x: positions.reduce((total, position) => total + position.x, 0) / positions.length,
      y: positions.reduce((total, position) => total + position.y, 0) / positions.length,
    };
  }

  private clearRateState(userId: string): void {
    this.signalWindows.delete(userId);
    for (const key of this.lastGameActionAt.keys()) {
      if (key.startsWith(`${userId}:`)) this.lastGameActionAt.delete(key);
    }
  }

  private requirePermanent(participant: CircleParticipant): boolean {
    if (participant.socialReady) return true;
    this.error(participant.userId, "circle_account", "Finish account setup before using private voice and games.");
    return false;
  }

  private async cleanup(now: number): Promise<void> {
    for (const [id, invitation] of this.invitations) {
      if (invitation.expiresAt <= now) this.invitations.delete(id);
    }
    for (const [id, originalCircle] of [...this.circles]) {
      originalCircle.disconnectedAt ??= {};
      for (const userId of [...originalCircle.memberIds]) {
        if (this.adapter.participant(userId)) {
          delete originalCircle.disconnectedAt[userId];
          continue;
        }
        originalCircle.disconnectedAt[userId] ??= now;
        if (originalCircle.disconnectedAt[userId] + RECONNECT_GRACE_MS <= now) {
          await this.removeMember(originalCircle, userId, "Connection timed out.");
        }
      }
      const circle = this.circles.get(id);
      if (!circle) continue;
      if (!circle.memberIds.length) {
        this.circles.delete(id);
        continue;
      }
      if (circle.memberIds.length === 1) {
        circle.loneSince ??= now;
        if (circle.loneSince + LONE_CIRCLE_LIFETIME_MS <= now) {
          const remainingId = circle.memberIds[0];
          this.adapter.send(remainingId, { type: "circle-closed", circleId: circle.id, reason: "The empty Circle closed." });
          this.clearRateState(remainingId);
          this.circles.delete(id);
          this.adapter.publishPresence(remainingId);
        }
      } else {
        circle.loneSince = null;
      }
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const storedCircles = [...this.circles.values()].map(circle => (
      circle.gameState?.kind === "draw"
        ? { ...circle, gameState: { ...circle.gameState, strokes: [] } }
        : circle
    ));
    const activeDrawingKeys = new Set<string>();
    const drawingWrites: Array<Promise<void>> = [];
    for (const circle of this.circles.values()) {
      if (circle.gameState?.kind !== "draw") continue;
      const key = drawingStorageKey(circle.id);
      activeDrawingKeys.add(key);
      drawingWrites.push(this.ctx.storage.put(key, circle.gameState.strokes));
    }
    const staleDrawingKeys = [...this.persistedDrawingKeys].filter(key => !activeDrawingKeys.has(key));
    await Promise.all([
      this.ctx.storage.put(CIRCLES_STORAGE_KEY, storedCircles),
      this.ctx.storage.put(INVITATIONS_STORAGE_KEY, [...this.invitations.values()]),
      ...drawingWrites,
      ...(staleDrawingKeys.length ? [this.ctx.storage.delete(staleDrawingKeys).then(() => undefined)] : []),
    ]);
    this.persistedDrawingKeys.clear();
    for (const key of activeDrawingKeys) this.persistedDrawingKeys.add(key);
    const nextTimes = [
      ...[...this.invitations.values()].map(invitation => invitation.expiresAt),
      ...[...this.circles.values()]
        .filter(circle => circle.memberIds.length === 1 && circle.loneSince !== null)
        .map(circle => circle.loneSince! + LONE_CIRCLE_LIFETIME_MS),
      ...[...this.circles.values()].flatMap(circle => (
        Object.values(circle.disconnectedAt ?? {}).map(disconnectedAt => disconnectedAt + RECONNECT_GRACE_MS)
      )),
    ].filter(time => time > Date.now());
    if (nextTimes.length) await this.ctx.storage.setAlarm(Math.min(...nextTimes));
    else await this.ctx.storage.deleteAlarm();
  }

  private notice(userId: string, message: string): void {
    this.adapter.send(userId, { type: "error", code: "circle_notice", message });
  }

  private error(userId: string, code: string, message: string): void {
    this.adapter.send(userId, { type: "error", code, message });
  }
}

function isCircleMode(value: unknown): value is CircleMode {
  return value === "open" || value === "request" || value === "invite";
}

type DrawStrokes = Extract<StoredCircleGameState, { kind: "draw" }>["strokes"];

function drawingStorageKey(circleId: string): string {
  return `${DRAWING_STORAGE_PREFIX}${circleId}`;
}

function isCircleGame(value: unknown): value is CircleGame {
  return value === "cards" || value === "draw" || value === "bluff" || value === "square-off";
}

function validSignal(signal: CircleSignalData): boolean {
  if (!signal || typeof signal !== "object") return false;
  if ("description" in signal) {
    const description = signal.description;
    return Boolean(description
      && ["offer", "answer", "pranswer", "rollback"].includes(description.type)
      && (description.sdp === undefined || (typeof description.sdp === "string" && description.sdp.length <= 10_000)));
  }
  if ("candidate" in signal) {
    return Boolean(signal.candidate
      && typeof signal.candidate.candidate === "string"
      && signal.candidate.candidate.length <= 2_000);
  }
  return false;
}

function distanceSquared(x1: number, y1: number, x2: number, y2: number): number {
  return (x1 - x2) ** 2 + (y1 - y2) ** 2;
}
