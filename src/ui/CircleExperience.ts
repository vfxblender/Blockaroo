import type {
  CircleGame,
  CircleGameSnapshot,
  CircleMember,
  CircleMode,
  CircleState,
  ServerCircleInviteMessage,
  ServerCircleJoinRequestMessage,
} from "../../shared/worldProtocol";
import type { CircleVoiceStatus } from "../circles/CircleVoice";
import { circleGameAvailability } from "../circles/gameAvailability";
import { escapeAttribute, escapeHtml } from "./html";

interface CircleExperienceActions {
  onInviteResponse(invitationId: string, accept: boolean): void;
  onJoinResponse(requesterPlayerId: string, accept: boolean): void;
  onLeave(): void;
  onMode(mode: CircleMode): void;
  onKick(playerId: string): void;
  onMute(): void;
  onStartGame(game: CircleGame): void;
  onEndGame(): void;
  onGameAction(action: string, payload?: unknown): void;
  onAddFriend(userId: string): Promise<string>;
  onOpenChange(open: boolean): void;
  onInteraction(): void;
}

const GAME_INFO: Record<CircleGame, { name: string; players: string; description: string }> = {
  cards: { name: "Crazy Blocks", players: "2–6", description: "Match colors and symbols. Empty your hand first." },
  draw: { name: "Draw & Guess", players: "2–6", description: "Sketch the secret word while the Circle guesses." },
  bluff: { name: "Bluff / Impostor", players: "4–6", description: "One player has no word. Talk, bluff, then vote." },
  "square-off": { name: "Square-Off", players: "2–4 active", description: "Bump rivals out of a shrinking arena. Extra members spectate." },
};

export class CircleExperience {
  private readonly dock: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly toastStack: HTMLElement;
  private circle: CircleState | null = null;
  private snapshot: CircleGameSnapshot | null = null;
  private localPlayerId = "";
  private open = false;
  private voiceStatus: CircleVoiceStatus = "idle";
  private voiceDetail = "";
  private avatarRect: DOMRect | null = null;
  private accent = "#ffd166";
  private squareKeys = new Set<string>();
  private squareMoveTimer: number | null = null;

  constructor(private readonly actions: CircleExperienceActions) {
    this.dock = document.createElement("aside");
    this.dock.className = "circle-dock";
    this.dock.hidden = true;
    this.overlay = document.createElement("section");
    this.overlay.className = "circle-experience";
    this.overlay.hidden = true;
    this.overlay.setAttribute("aria-label", "Circle");
    this.toastStack = document.createElement("section");
    this.toastStack.className = "social-toast-stack";
    this.toastStack.setAttribute("aria-live", "polite");
    document.body.append(this.dock, this.overlay, this.toastStack);
    this.dock.addEventListener("click", event => this.handleClick(event));
    this.overlay.addEventListener("click", event => this.handleClick(event));
    this.overlay.addEventListener("change", event => this.handleChange(event));
    this.overlay.addEventListener("submit", event => this.handleSubmit(event));
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setAvatarOrigin(rect: DOMRect, color: string): void {
    this.avatarRect = rect;
    this.accent = color;
  }

  setCircle(circle: CircleState, localPlayerId: string): void {
    const previousGame = this.circle?.game;
    const isNewCircle = this.circle?.id !== circle.id;
    this.circle = circle;
    this.localPlayerId = localPlayerId;
    this.dock.hidden = false;
    this.renderDock();
    if (this.open) this.renderOverlay();
    if (isNewCircle || (!previousGame && circle.game)) this.show();
  }

  clearCircle(reason?: string): void {
    this.circle = null;
    this.snapshot = null;
    this.dock.hidden = true;
    this.hide();
    if (reason) this.toast("Circle closed", reason);
  }

  setGameSnapshot(snapshot: CircleGameSnapshot): void {
    const previous = this.snapshot;
    const drawingDelta = snapshot.game === "draw"
      && snapshot.publicState.strokeDelta === true
      && previous?.game === "draw"
      && readString(previous.publicState, "artistId") === readString(snapshot.publicState, "artistId");
    const deltaStrokes = drawingDelta && Array.isArray(snapshot.publicState.strokes)
      ? snapshot.publicState.strokes as Array<Record<string, unknown>>
      : [];
    if (drawingDelta) {
      const previousStrokes = Array.isArray(previous.publicState.strokes)
        ? previous.publicState.strokes as Array<Record<string, unknown>>
        : [];
      snapshot = {
        ...snapshot,
        publicState: {
          ...snapshot.publicState,
          strokes: [...previousStrokes, ...deltaStrokes].slice(-1_200),
          strokeDelta: false,
        },
      };
    }
    this.snapshot = snapshot;
    if (!this.open) {
      this.renderDock();
      return;
    }
    if (drawingDelta) {
      if (!snapshot.privateState?.isArtist) this.appendDrawingStrokes(deltaStrokes);
      this.updateDrawingMessage();
      return;
    }
    const canUpdateDrawing = previous?.game === "draw"
      && snapshot.game === "draw"
      && readString(previous.publicState, "artistId") === readString(snapshot.publicState, "artistId")
      && Boolean(previous.privateState?.isArtist) === Boolean(snapshot.privateState?.isArtist);
    if (canUpdateDrawing) this.updateDrawingSurface();
    else this.renderOverlay();
  }

  setVoiceStatus(status: CircleVoiceStatus, detail = ""): void {
    this.voiceStatus = status;
    this.voiceDetail = detail;
    this.renderDock();
    if (this.open) this.updateVoiceStatus();
  }

  showInvite(message: ServerCircleInviteMessage): void {
    const toast = this.makeToast(
      "Circle invitation",
      `${message.fromPlayer.username} wants to talk and play.`,
      [
        ["Join Circle", () => this.actions.onInviteResponse(message.invitationId, true)],
        ["Not now", () => this.actions.onInviteResponse(message.invitationId, false)],
      ],
    );
    const expiresIn = Math.max(0, message.expiresAt - Date.now());
    window.setTimeout(() => toast.remove(), expiresIn);
  }

  showJoinRequest(message: ServerCircleJoinRequestMessage): void {
    this.makeToast(
      "Ask to join",
      `${message.requester.username} wants into your Circle.`,
      [
        ["Let them in", () => this.actions.onJoinResponse(message.requester.id, true)],
        ["Decline", () => this.actions.onJoinResponse(message.requester.id, false)],
      ],
    );
  }

  toast(title: string, message: string): void {
    this.makeToast(title, message, [["OK", () => undefined]]);
  }

  showConnectionRecap(members: CircleMember[], localPlayerId: string): void {
    const people = members.filter(member => member.playerId !== localPlayerId);
    if (!people.length) return;
    const toast = document.createElement("article");
    toast.className = "social-toast circle-recap-toast";
    toast.innerHTML = `
      <div class="circle-recap-copy">
        <strong>People from your Circle</strong>
        <p>Add anyone you actually want to see again.</p>
      </div>
      <div class="circle-recap-people"></div>
      <button class="toast-secondary circle-recap-done">Done</button>
    `;
    const list = toast.querySelector<HTMLElement>(".circle-recap-people")!;
    for (const member of people) {
      const row = document.createElement("div");
      row.className = "circle-recap-person";
      row.innerHTML = `
        <i style="--member-color:${escapeAttribute(member.color)}"></i>
        <span>${escapeHtml(member.username)}</span>
      `;
      const button = document.createElement("button");
      button.className = "toast-primary";
      button.textContent = "Add friend";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const result = await this.actions.onAddFriend(member.authUserId);
          button.textContent = /now friends/i.test(result) ? "Friends" : "Request sent";
        } catch (error) {
          button.disabled = false;
          button.textContent = "Try again";
          this.toast("Friend request", error instanceof Error ? error.message : "Friend request failed.");
        }
      });
      row.append(button);
      list.append(row);
    }
    toast.querySelector<HTMLButtonElement>(".circle-recap-done")!.addEventListener("click", () => toast.remove(), { once: true });
    this.toastStack.append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
  }

  show(): void {
    if (!this.circle) return;
    this.open = true;
    this.overlay.hidden = false;
    this.positionOrigin();
    this.renderOverlay();
    requestAnimationFrame(() => this.overlay.classList.add("is-open"));
    this.actions.onOpenChange(true);
  }

  hide(): void {
    if (!this.open && this.overlay.hidden) return;
    this.open = false;
    this.stopSquareMovement();
    this.overlay.classList.remove("is-open");
    this.actions.onOpenChange(false);
    window.setTimeout(() => {
      if (!this.open) this.overlay.hidden = true;
    }, 280);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.stopSquareMovement();
    this.dock.remove();
    this.overlay.remove();
    this.toastStack.remove();
  }

  private renderDock(): void {
    if (!this.circle) return;
    const memberDots = this.circle.members
      .map(member => `<span class="circle-member-dot" style="--member-color:${escapeAttribute(member.color)}" title="${escapeAttribute(member.username)}"></span>`)
      .join("");
    const status = this.circle.game ? GAME_INFO[this.circle.game].name : "Private voice";
    this.dock.innerHTML = `
      <button class="circle-dock-main" data-circle-action="open" aria-label="Open Circle">
        <span class="circle-mini-ring">${memberDots}</span>
        <span><strong>${escapeHtml(status)}</strong><small>${this.circle.members.length}/6 · ${escapeHtml(this.voiceLabel())}</small></span>
      </button>
      <button class="circle-icon-button" data-circle-action="mute" aria-label="${this.voiceControlLabel()}">${this.voiceControlIcon()}</button>
    `;
  }

  private renderOverlay(): void {
    if (!this.circle) return;
    const isHost = this.circle.hostPlayerId === this.localPlayerId;
    const memberList = this.circle.members.map(member => `
      <li class="circle-member">
        <span class="circle-member-block" style="--member-color:${escapeAttribute(member.color)}">${member.isMuted ? "×" : ""}</span>
        <span><strong>${escapeHtml(member.username)}</strong><small>${member.isHost ? "Host" : "Member"}${member.playerId === this.localPlayerId ? " · You" : ""}</small></span>
        ${isHost && member.playerId !== this.localPlayerId ? `<button class="quiet-button" data-circle-action="kick" data-player-id="${escapeAttribute(member.playerId)}">Remove</button>` : ""}
      </li>
    `).join("");
    const body = this.circle.game ? this.renderGame() : this.renderLobby(isHost);
    this.overlay.innerHTML = `
      <div class="circle-shell">
        <header class="circle-header">
          <div>
            <span class="eyebrow">PRIVATE CIRCLE · ${this.circle.members.length}/6</span>
            <h1>${this.circle.game ? escapeHtml(GAME_INFO[this.circle.game].name) : "Talk. Play. Connect."}</h1>
          </div>
          <div class="circle-header-actions">
            ${isHost && this.circle.game ? `<button class="quiet-button" data-circle-action="end-game">Games</button>` : ""}
            <button class="circle-icon-button is-large" data-circle-action="mute" aria-label="${this.voiceControlLabel()}">${this.voiceControlIcon()}</button>
            <button class="circle-close" data-circle-action="close" aria-label="Minimize Circle">—</button>
          </div>
        </header>
        <div class="circle-content">
          <aside class="circle-sidebar">
            <div class="voice-status" data-voice-status>${escapeHtml(this.voiceLabel())}${this.voiceDetail ? `<small>${escapeHtml(this.voiceDetail)}</small>` : ""}</div>
            <ul>${memberList}</ul>
            ${isHost ? `
              <label class="circle-access">Access
                <select data-circle-action="mode">
                  <option value="open" ${this.circle.mode === "open" ? "selected" : ""}>Open</option>
                  <option value="request" ${this.circle.mode === "request" ? "selected" : ""}>Ask to join</option>
                  <option value="invite" ${this.circle.mode === "invite" ? "selected" : ""}>Invite only</option>
                </select>
              </label>
            ` : `<p class="circle-access-note">${modeLabel(this.circle.mode)}</p>`}
            <button class="danger-text-button" data-circle-action="leave">Leave Circle</button>
          </aside>
          <main class="circle-main">${body}</main>
        </div>
      </div>
    `;
    this.bindGameSurface();
  }

  private renderLobby(isHost: boolean): string {
    const memberCount = this.circle?.members.length ?? 0;
    const gameCards = (Object.entries(GAME_INFO) as Array<[CircleGame, (typeof GAME_INFO)[CircleGame]]>)
      .map(([game, info]) => {
        const availability = circleGameAvailability(game, memberCount);
        const disabled = !isHost || !availability.canStart;
        const buttonLabel = !isHost ? "Host starts" : availability.canStart ? "Start" : availability.reason;
        return `
          <article class="game-choice">
            <span class="game-glyph">${gameGlyph(game)}</span>
            <div><h2>${escapeHtml(info.name)}</h2><small>${info.players} players</small><p>${escapeHtml(info.description)}</p></div>
            <button data-circle-action="start-game" data-game="${game}" ${disabled ? "disabled" : ""}>${escapeHtml(buttonLabel)}</button>
          </article>
        `;
      }).join("");
    return `
      <section class="circle-lobby">
        <div class="circle-lobby-intro">
          <span class="eyebrow">YOUR SQUARE BECAME THE ROOM</span>
          <h2>Choose what happens next.</h2>
          <p>Voice stays private. People outside only see that your Circle is active.</p>
        </div>
        <div class="game-grid">${gameCards}</div>
      </section>
    `;
  }

  private renderGame(): string {
    if (!this.circle?.game) return "";
    if (!this.snapshot || this.snapshot.game !== this.circle.game) {
      return `<div class="game-loading"><span class="block-loader"></span><p>Setting up ${escapeHtml(GAME_INFO[this.circle.game].name)}…</p></div>`;
    }
    if (this.snapshot.game === "cards") return this.renderCards();
    if (this.snapshot.game === "draw") return this.renderDraw();
    if (this.snapshot.game === "bluff") return this.renderBluff();
    return this.renderSquareOff();
  }

  private renderCards(): string {
    const publicState = this.snapshot!.publicState;
    const hand = Array.isArray(this.snapshot!.privateState?.hand) ? this.snapshot!.privateState!.hand as Array<Record<string, unknown>> : [];
    const top = objectValue(publicState, "topCard");
    const currentPlayerId = readString(publicState, "currentPlayerId");
    const handCounts = objectValue(publicState, "handCounts") ?? {};
    const opponents = this.circle!.members.map(member => `
      <span class="opponent-hand ${member.playerId === currentPlayerId ? "is-turn" : ""}">
        <i style="--member-color:${escapeAttribute(member.color)}"></i>
        ${escapeHtml(member.username)} · ${Number(handCounts[member.playerId] ?? 0)} cards
      </span>
    `).join("");
    const cards = hand.map((card, index) => {
      const color = String(card.color ?? "wild");
      const rank = String(card.rank ?? "?");
      return `<button class="playing-card card-${escapeAttribute(color)}" data-circle-action="play-card" data-card-index="${index}" ${currentPlayerId !== this.localPlayerId ? "disabled" : ""}><span>${escapeHtml(rank)}</span><small>${escapeHtml(color)}</small></button>`;
    }).join("");
    return `
      <section class="cards-game">
        <div class="game-status">${escapeHtml(readString(publicState, "message"))}</div>
        <div class="opponent-row">${opponents}</div>
        <div class="card-table">
          <div class="deck-stack"><span>BLOCK</span></div>
          <div class="playing-card card-${escapeAttribute(String(top?.color ?? "wild"))} is-top"><span>${escapeHtml(String(top?.rank ?? "?"))}</span><small>${escapeHtml(String(top?.color ?? "wild"))}</small></div>
        </div>
        <div class="your-hand">${cards || "<p>You emptied your hand.</p>"}</div>
        <button class="game-primary" data-circle-action="draw-card" ${currentPlayerId !== this.localPlayerId ? "disabled" : ""}>Draw card</button>
      </section>
    `;
  }

  private renderDraw(): string {
    const state = this.snapshot!.publicState;
    const isArtist = Boolean(this.snapshot!.privateState?.isArtist);
    const word = isArtist ? String(this.snapshot!.privateState?.word ?? "") : readString(state, "maskedWord");
    return `
      <section class="draw-game">
        <div class="draw-toolbar">
          <div><span>${isArtist ? "Draw this" : "Secret word"}</span><strong>${escapeHtml(word)}</strong></div>
          <div class="game-status" data-draw-message>${escapeHtml(readString(state, "message"))}</div>
          ${isArtist ? `<button class="quiet-button" data-circle-action="clear-drawing">Clear</button><button class="quiet-button" data-circle-action="skip-drawing">Skip</button>` : ""}
        </div>
        <canvas class="draw-canvas" width="900" height="520" data-draw-canvas aria-label="Shared drawing canvas"></canvas>
        ${isArtist ? `<p class="draw-hint">Draw with your pointer. Don’t write the word.</p>` : `
          <form class="guess-form" data-circle-form="guess">
            <input name="guess" maxlength="60" autocomplete="off" placeholder="What is it?" aria-label="Your guess" />
            <button>Guess</button>
          </form>
        `}
      </section>
    `;
  }

  private renderBluff(): string {
    const state = this.snapshot!.publicState;
    const role = String(this.snapshot!.privateState?.role ?? "spectator");
    const word = this.snapshot!.privateState?.word;
    const phase = this.snapshot!.phase;
    const voteButtons = phase === "discussion" ? this.circle!.members
      .filter(member => member.playerId !== this.localPlayerId)
      .map(member => `<button class="vote-player" data-circle-action="bluff-vote" data-player-id="${escapeAttribute(member.playerId)}"><i style="--member-color:${escapeAttribute(member.color)}"></i>${escapeHtml(member.username)}</button>`)
      .join("") : "";
    const isHost = this.circle!.hostPlayerId === this.localPlayerId;
    return `
      <section class="bluff-game">
        <article class="role-card ${role === "impostor" ? "is-impostor" : ""}">
          <span>Your role</span>
          <h2>${role === "impostor" ? "IMPOSTOR" : role === "crew" ? "YOU KNOW THE WORD" : "SPECTATOR"}</h2>
          <strong>${word ? escapeHtml(String(word)) : role === "impostor" ? "Listen. Bluff. Survive." : ""}</strong>
        </article>
        <div class="game-status">${escapeHtml(readString(state, "message"))}</div>
        ${phase === "discussion" ? `<div class="bluff-instructions"><h3>Talk it out in voice.</h3><p>Describe the word indirectly. When you think you know the impostor, vote.</p></div><div class="vote-grid">${voteButtons}</div>` : `
          <div class="bluff-result">
            <span>${readString(state, "winners") === "crew" ? "Crew wins" : "Impostor wins"}</span>
            <h2>The word was ${escapeHtml(readString(state, "revealedWord"))}</h2>
            ${isHost ? `<button class="game-primary" data-circle-action="bluff-next">Next round</button>` : "<p>Waiting for the host.</p>"}
          </div>
        `}
      </section>
    `;
  }

  private renderSquareOff(): string {
    const state = this.snapshot!.publicState;
    const positions = objectValue(state, "positions") ?? {};
    const startedAt = Number(state.startedAt ?? Date.now());
    const elapsed = Math.max(0, Date.now() - startedAt);
    const radius = this.snapshot!.phase === "playing"
      ? Math.max(0.38, 1 - (elapsed / 90_000) * 0.62)
      : Math.max(0.2, Math.min(1, Number(state.arenaRadius ?? 1)));
    const shrinkMs = Math.max(0, 90_000 - elapsed);
    const blocks = this.circle!.members.flatMap(member => {
      const position = positions[member.playerId];
      if (!position || typeof position !== "object") return [];
      const raw = position as Record<string, unknown>;
      const x = Number(raw.x ?? 0);
      const y = Number(raw.y ?? 0);
      const eliminated = Boolean(raw.eliminated);
      return [`<span class="arena-player ${eliminated ? "is-out" : ""}" style="--member-color:${escapeAttribute(member.color)};left:${50 + x * 42}%;top:${50 + y * 42}%" title="${escapeAttribute(member.username)}"></span>`];
    }).join("");
    const isHost = this.circle!.hostPlayerId === this.localPlayerId;
    return `
      <section class="square-off-game">
        <div class="game-status">${escapeHtml(readString(state, "message"))}</div>
        <div class="square-arena"><div class="arena-boundary" style="width:${radius * 92}%;height:${radius * 92}%;${this.snapshot!.phase === "playing" && shrinkMs ? `animation:square-shrink ${shrinkMs}ms linear forwards` : ""}"></div>${blocks}</div>
        <div class="square-controls" aria-label="Square-Off controls">
          <button data-square-dx="0" data-square-dy="-1">↑</button>
          <button data-square-dx="-1" data-square-dy="0">←</button>
          <button data-square-dx="0" data-square-dy="1">↓</button>
          <button data-square-dx="1" data-square-dy="0">→</button>
        </div>
        <p>WASD / arrows or tap the controls. Bump rivals past the ring.</p>
        ${this.snapshot!.phase === "finished" && isHost ? `<button class="game-primary" data-circle-action="square-restart">Next round</button>` : ""}
      </section>
    `;
  }

  private bindGameSurface(): void {
    if (this.snapshot?.game !== "draw") return;
    const canvas = this.overlay.querySelector<HTMLCanvasElement>("[data-draw-canvas]");
    if (!canvas) return;
    this.paintStrokes(canvas);
    if (!this.snapshot.privateState?.isArtist) return;
    let drawing = false;
    let last: { x: number; y: number } | null = null;
    let lastSentAt = 0;
    const point = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
    };
    canvas.addEventListener("pointerdown", event => {
      drawing = true;
      last = point(event);
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      if (!drawing || !last) return;
      if (Array.isArray(this.snapshot?.publicState.strokes) && this.snapshot.publicState.strokes.length >= 1_200) return;
      const next = point(event);
      if (Math.hypot(next.x - last.x, next.y - last.y) < 0.004) return;
      if (performance.now() - lastSentAt < 25) return;
      const stroke = { x1: last.x, y1: last.y, x2: next.x, y2: next.y, color: "#14213d", width: 5 };
      const context = canvas.getContext("2d");
      if (context) this.paintStroke(context, canvas, stroke);
      this.actions.onGameAction("stroke", stroke);
      last = next;
      lastSentAt = performance.now();
    });
    const stop = () => { drawing = false; last = null; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  private updateDrawingSurface(): void {
    const canvas = this.overlay.querySelector<HTMLCanvasElement>("[data-draw-canvas]");
    if (canvas) this.paintStrokes(canvas);
    this.updateDrawingMessage();
  }

  private updateDrawingMessage(): void {
    const message = this.overlay.querySelector<HTMLElement>("[data-draw-message]");
    if (message && this.snapshot) message.textContent = readString(this.snapshot.publicState, "message");
  }

  private appendDrawingStrokes(strokes: Array<Record<string, unknown>>): void {
    const canvas = this.overlay.querySelector<HTMLCanvasElement>("[data-draw-canvas]");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    for (const stroke of strokes) this.paintStroke(context, canvas, stroke);
  }

  private paintStrokes(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext("2d");
    if (!context || !this.snapshot) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fffdf7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const strokes = Array.isArray(this.snapshot.publicState.strokes)
      ? this.snapshot.publicState.strokes as Array<Record<string, unknown>>
      : [];
    for (const stroke of strokes) this.paintStroke(context, canvas, stroke);
  }

  private paintStroke(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, stroke: Record<string, unknown>): void {
    context.beginPath();
    context.moveTo(Number(stroke.x1) * canvas.width, Number(stroke.y1) * canvas.height);
    context.lineTo(Number(stroke.x2) * canvas.width, Number(stroke.y2) * canvas.height);
    context.strokeStyle = String(stroke.color ?? "#14213d");
    context.lineWidth = Number(stroke.width ?? 5);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  }

  private handleClick(event: Event): void {
    this.actions.onInteraction();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-circle-action], [data-square-dx]");
    if (!target) return;
    const action = target.dataset.circleAction;
    if (action === "open") return this.show();
    if (action === "close") return this.hide();
    if (action === "leave") return this.actions.onLeave();
    if (action === "mute") return this.actions.onMute();
    if (action === "kick" && target.dataset.playerId) return this.actions.onKick(target.dataset.playerId);
    if (action === "start-game" && isCircleGame(target.dataset.game)) return this.actions.onStartGame(target.dataset.game);
    if (action === "end-game") return this.actions.onEndGame();
    if (action === "play-card") return this.actions.onGameAction("play", { index: Number(target.dataset.cardIndex) });
    if (action === "draw-card") return this.actions.onGameAction("draw");
    if (action === "clear-drawing") return this.actions.onGameAction("clear");
    if (action === "skip-drawing") return this.actions.onGameAction("skip");
    if (action === "bluff-vote" && target.dataset.playerId) return this.actions.onGameAction("vote", { targetId: target.dataset.playerId });
    if (action === "bluff-next") return this.actions.onGameAction("next");
    if (action === "square-restart") return this.actions.onGameAction("restart");
    if (target.dataset.squareDx !== undefined) {
      this.actions.onGameAction("move", { dx: Number(target.dataset.squareDx), dy: Number(target.dataset.squareDy) });
    }
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.circleAction === "mode" && isCircleMode(target.value)) this.actions.onMode(target.value);
  }

  private handleSubmit(event: SubmitEvent): void {
    const form = event.target as HTMLFormElement;
    if (form.dataset.circleForm !== "guess") return;
    event.preventDefault();
    const data = new FormData(form);
    const guess = String(data.get("guess") ?? "").trim();
    if (guess) this.actions.onGameAction("guess", { guess });
    form.reset();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.open || this.snapshot?.game !== "square-off" || document.activeElement instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (!["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"].includes(key)) return;
    event.preventDefault();
    this.squareKeys.add(key);
    if (!event.repeat) this.sendSquareKeyMovement();
    if (this.squareMoveTimer === null) {
      this.squareMoveTimer = window.setInterval(() => this.sendSquareKeyMovement(), 120);
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.squareKeys.delete(event.key.toLowerCase());
    if (!this.squareKeys.size) this.stopSquareMovement();
  };

  private sendSquareKeyMovement(): void {
    const dx = Number(this.squareKeys.has("arrowright") || this.squareKeys.has("d"))
      - Number(this.squareKeys.has("arrowleft") || this.squareKeys.has("a"));
    const dy = Number(this.squareKeys.has("arrowdown") || this.squareKeys.has("s"))
      - Number(this.squareKeys.has("arrowup") || this.squareKeys.has("w"));
    if (dx || dy) this.actions.onGameAction("move", { dx, dy });
  }

  private stopSquareMovement(): void {
    if (this.squareMoveTimer !== null) window.clearInterval(this.squareMoveTimer);
    this.squareMoveTimer = null;
    this.squareKeys.clear();
  }

  private updateVoiceStatus(): void {
    const element = this.overlay.querySelector<HTMLElement>("[data-voice-status]");
    if (element) element.innerHTML = `${escapeHtml(this.voiceLabel())}${this.voiceDetail ? `<small>${escapeHtml(this.voiceDetail)}</small>` : ""}`;
  }

  private voiceLabel(): string {
    if (this.voiceStatus === "requesting") return "Connecting voice…";
    if (this.voiceStatus === "connected") return "Voice connected";
    if (this.voiceStatus === "muted") return "Microphone muted";
    if (this.voiceStatus === "unavailable") return "Voice unavailable";
    if (this.voiceStatus === "error") return "Voice connection issue";
    return "Voice waiting";
  }

  private voiceControlLabel(): string {
    if (this.voiceStatus === "unavailable" || this.voiceStatus === "error") return "Retry microphone";
    return this.voiceStatus === "muted" ? "Unmute microphone" : "Mute microphone";
  }

  private voiceControlIcon(): string {
    if (this.voiceStatus === "unavailable" || this.voiceStatus === "error") return "↻";
    return this.voiceStatus === "muted" ? "🔇" : "🎙";
  }

  private positionOrigin(): void {
    const rect = this.avatarRect;
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    this.overlay.style.setProperty("--portal-x", `${x}px`);
    this.overlay.style.setProperty("--portal-y", `${y}px`);
    this.overlay.style.setProperty("--portal-color", this.accent);
  }

  private makeToast(title: string, message: string, actions: Array<[string, () => void]>): HTMLElement {
    const toast = document.createElement("article");
    toast.className = "social-toast";
    toast.innerHTML = `<div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div><div class="social-toast-actions"></div>`;
    const actionRow = toast.querySelector<HTMLElement>(".social-toast-actions")!;
    actions.forEach(([label, callback], index) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.className = index === 0 ? "toast-primary" : "toast-secondary";
      button.addEventListener("click", () => {
        callback();
        toast.remove();
      }, { once: true });
      actionRow.append(button);
    });
    this.toastStack.append(toast);
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    return toast;
  }
}

function modeLabel(mode: CircleMode): string {
  if (mode === "open") return "Friends can join this open Circle.";
  if (mode === "request") return "New members ask the host to join.";
  return "Only invited players can enter.";
}

function gameGlyph(game: CircleGame): string {
  if (game === "cards") return "▰";
  if (game === "draw") return "✎";
  if (game === "bluff") return "?";
  return "◩";
}

function isCircleGame(value: unknown): value is CircleGame {
  return value === "cards" || value === "draw" || value === "bluff" || value === "square-off";
}

function isCircleMode(value: unknown): value is CircleMode {
  return value === "open" || value === "request" || value === "invite";
}

function objectValue(state: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = state[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(state: Record<string, unknown>, key: string): string {
  const value = state[key];
  return value === null || value === undefined ? "" : String(value);
}
