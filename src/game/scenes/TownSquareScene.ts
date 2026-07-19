import Phaser from "phaser";
import { PALETTE, WORLD } from "../config";
import { loadProfile, saveProfile } from "../systems/LocalProfile";
import { LOCAL_TOWN_NEIGHBORS, type LocalTownNeighbor } from "../systems/LocalTownNeighbors";
import { createTownSquareTransport } from "../systems/createTownSquareTransport";
import type { BlockChatMessage, OnlinePlayer, TownSquareTransport } from "../systems/TownSquareTransport";
import { WorldRouter } from "../systems/WorldRouter";
import type { PlayerIdentity } from "../types/world";

type Remote = {
  body: Phaser.GameObjects.Container;
  target: Phaser.Math.Vector2;
  velocity: Phaser.Math.Vector2;
  updatedAt: number;
  zone: 1 | 2;
};

type LocalNeighborSprite = LocalTownNeighbor & { body: Phaser.GameObjects.Container };

const MAX_IMAGE_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_CHARS = 140_000;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class TownSquareScene extends Phaser.Scene {
  private profile = loadProfile();
  private player!: Phaser.GameObjects.Container;
  private nameLabel!: Phaser.GameObjects.Text;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private joystick = new Phaser.Math.Vector2();
  private moveTarget: Phaser.Math.Vector2 | null = null;
  private remotes = new Map<string, Remote>();
  private localNeighbors: LocalNeighborSprite[] = [];
  private network: TownSquareTransport | null = null;
  private statusElement: HTMLElement | null = null;
  private onlineCount = 1;
  private connectionStatus: "connecting" | "online" | "offline" | "error" = "connecting";
  private reconnecting = false;
  private reconnectTimer: number | null = null;
  private wasHidden = document.visibilityState === "hidden";
  private chatForm: HTMLFormElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private photoInput: HTMLInputElement | null = null;
  private photoButton: HTMLButtonElement | null = null;
  private photoPrepareGeneration = 0;
  private profilePanel: HTMLElement | null = null;
  private composingChat = false;
  private localCorrection: Phaser.Math.Vector2 | null = null;
  private router = new WorldRouter();

  constructor() { super("TownSquare"); }

  create(): void {
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.drawWorld();
    this.createLocalNeighbors();
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnRadius = Phaser.Math.Between(175, 285);
    this.player = this.makePlayer(this.profile, 1100 + Math.cos(spawnAngle) * spawnRadius, 750 + Math.sin(spawnAngle) * spawnRadius, true);
    this.nameLabel = this.player.getAt(1) as Phaser.GameObjects.Text;
    this.physics.add.existing(this.player);
    (this.player.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setZoom(Phaser.Math.Clamp(Math.min(this.scale.width / 720, this.scale.height / 500), 0.72, 1.15));

    this.cursors = this.input.keyboard!.createCursorKeys();
    // Keep WASD available to normal browser text fields. Movement still reads
    // the key state, but Phaser must not call preventDefault for these letters.
    this.keys = this.input.keyboard!.addKeys("W,A,S,D", false) as Record<string, Phaser.Input.Keyboard.Key>;
    this.createHud();
    void this.startMultiplayer();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.closeChatComposer(true);
      this.moveTarget = new Phaser.Math.Vector2(pointer.worldX, pointer.worldY);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      window.removeEventListener("focus", this.handleNetworkResume);
      window.removeEventListener("online", this.handleNetworkResume);
      window.removeEventListener("pageshow", this.handleNetworkResume);
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      void this.network?.disconnect();
      for (const remote of this.remotes.values()) remote.body.destroy(true);
      this.remotes.clear();
      for (const neighbor of this.localNeighbors) neighbor.body.destroy(true);
      this.localNeighbors = [];
    });
  }

  update(time: number, delta: number): void {
    const speed = 220;
    let x = 0; let y = 0;
    const isEditingText = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    if (!isEditingText) {
      if (this.cursors.left.isDown || this.keys.A.isDown) x -= 1;
      if (this.cursors.right.isDown || this.keys.D.isDown) x += 1;
      if (this.cursors.up.isDown || this.keys.W.isDown) y -= 1;
      if (this.cursors.down.isDown || this.keys.S.isDown) y += 1;
    }
    x += this.joystick.x; y += this.joystick.y;
    if (x !== 0 || y !== 0) {
      this.moveTarget = null;
    } else if (this.moveTarget) {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, this.moveTarget.x, this.moveTarget.y);
      if (distance < 10) {
        this.moveTarget = null;
      } else {
        x = this.moveTarget.x - this.player.x;
        y = this.moveTarget.y - this.player.y;
      }
    }
    const direction = new Phaser.Math.Vector2(x, y).normalize();
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(direction.x * speed, direction.y * speed);
    this.player.setDepth(this.player.y);

    this.network?.sendMovement(this.profile, this.player.x, this.player.y, direction.x, direction.y);
    if (this.localCorrection) {
      const correctionBlend = 1 - Math.exp(-delta * 0.009);
      this.player.x += this.localCorrection.x * correctionBlend;
      this.player.y += this.localCorrection.y * correctionBlend;
      this.localCorrection.scale(1 - correctionBlend);
      if (this.localCorrection.length() < 1.5) {
        this.localCorrection = null;
      }
    }
    const blend = 1 - Math.exp(-delta * 0.012);
    for (const remote of this.remotes.values()) {
      const predictionSeconds = Phaser.Math.Clamp((Date.now() - remote.updatedAt) / 1000, 0, 4);
      const predictedX = Phaser.Math.Clamp(remote.target.x + remote.velocity.x * predictionSeconds, 21, WORLD.width - 21);
      const predictedY = Phaser.Math.Clamp(remote.target.y + remote.velocity.y * predictionSeconds, 21, WORLD.height - 21);
      remote.body.x = Phaser.Math.Linear(remote.body.x, predictedX, blend);
      remote.body.y = Phaser.Math.Linear(remote.body.y, predictedY, blend);
      remote.body.setDepth(remote.body.y);
    }
    for (const neighbor of this.localNeighbors) {
      const angle = neighbor.phase + time * neighbor.speed;
      neighbor.body.x = 1100 + Math.cos(angle) * neighbor.orbitRadius;
      neighbor.body.y = 750 + Math.sin(angle) * neighbor.orbitRadius * 0.68;
      neighbor.body.setDepth(neighbor.body.y);
    }
    this.updateChatComposerPosition();
  }

  private drawWorld(): void {
    const g = this.add.graphics();
    g.fillStyle(0x3e8c72).fillRect(0, 0, WORLD.width, WORLD.height);
    g.fillStyle(0x5ea982).fillCircle(1100, 750, 570);
    g.lineStyle(50, 0xcdbb8a, 1).strokeCircle(1100, 750, 520);
    g.fillStyle(0x89c5e3).fillCircle(1100, 750, 130);
    g.lineStyle(8, 0xe9f6ff, .8).strokeCircle(1100, 750, 100);
    g.fillStyle(0xf4e0a3).fillCircle(1100, 750, 35);
    for (let i = 0; i < 62; i++) {
      const x = Phaser.Math.Between(55, WORLD.width - 55), y = Phaser.Math.Between(55, WORLD.height - 55);
      if (Phaser.Math.Distance.Between(x, y, 1100, 750) < 180) continue;
      g.fillStyle(0x285b50).fillCircle(x, y, Phaser.Math.Between(16, 32));
      g.fillStyle(0x3e8167).fillCircle(x - 6, y - 8, Phaser.Math.Between(10, 20));
    }
    this.add.text(1100, 535, "THE FOUNTAIN", { fontFamily: "system-ui", fontSize: "14px", color: "#fff2c6", fontStyle: "bold" }).setOrigin(.5);
    this.add.text(1100, 100, "NASHVILLE TOWN SQUARE", { fontFamily: "system-ui", fontSize: "23px", color: "#f7f4ec", fontStyle: "bold" }).setOrigin(.5).setAlpha(.85);
  }

  private createLocalNeighbors(): void {
    this.localNeighbors = LOCAL_TOWN_NEIGHBORS.map(neighbor => ({
      ...neighbor,
      body: this.makePlayer(
        neighbor.identity,
        1100 + Math.cos(neighbor.phase) * neighbor.orbitRadius,
        750 + Math.sin(neighbor.phase) * neighbor.orbitRadius * 0.68,
        false,
        true,
      ),
    }));
  }

  private makePlayer(identity: PlayerIdentity, x: number, y: number, local = false, localGuide = false): Phaser.GameObjects.Container {
    const square = this.add.rectangle(0, 0, 42, 42, Phaser.Display.Color.HexStringToColor(identity.color).color, 1).setStrokeStyle(3, 0x0b1020, 1).setInteractive({ useHandCursor: true });
    const label = this.add.text(0, -39, identity.username, { fontFamily: "system-ui", fontSize: "13px", color: "#ffffff", stroke: "#17223a", strokeThickness: 4 }).setOrigin(.5);
    const block = this.add.container(x, y, [square, label]);
    block.setSize(42, 42);
    block.setDepth(y);
    block.setData("baseColor", identity.color);
    block.setData("messageActive", false);
    block.setData("localGuide", localGuide);
    if (local) {
      square.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.moveTarget = null;
        this.openChatComposer();
      });
    } else {
      square.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.moveTarget = null;
        const currentName = (block.getAt(1) as Phaser.GameObjects.Text).text;
        this.showBubble(
          block.x,
          block.y - 50,
          block.getData("localGuide") ? `${currentName} is a local town guide.` : `${currentName} is online nearby.`,
        );
      });
    }
    return block;
  }

  private createHud(): void {
    const hud = document.createElement("section");
    hud.className = "hud";
    hud.innerHTML = `<div class="topbar"><div class="brand">BLOCKAROO<small>Nashville · Town Square</small><span class="connection is-connecting">Connecting…</span></div><button class="edit">Your block</button></div><aside class="panel" hidden><h2>Your block</h2><label class="field">Display name<input maxlength="18" value="${this.escape(this.profile.username)}" /></label><label class="field">Block color<div class="swatches">${PALETTE.map(c => `<button class="swatch ${c === this.profile.color ? "selected" : ""}" aria-label="Choose color" style="background:${c}" data-color="${c}"></button>`).join("")}</div></label><button class="save">Enter Town Square</button></aside><form class="chat-composer" hidden><input maxlength="120" autocomplete="off" enterkeyhint="send" aria-label="Write a message" placeholder="Say something…" /><button type="button" class="photo-picker" aria-label="Add a temporary picture" title="Add a temporary picture"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7.5h3l1.4-2h5.2l1.4 2h1.5M4 7.5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11.5M4 7.5h12.5M12.5 18H8a3.5 3.5 0 1 1 5.7-2.7M19 10v8m-4-4h8" /></svg></button><input class="photo-input" type="file" accept="image/jpeg,image/png,image/webp" hidden /></form><div class="hint">Click your block to speak · WASD / arrows · tap ground · joystick</div><div class="joystick" aria-label="Movement joystick"><span class="joystick-knob"></span></div>`;
    document.body.append(hud);
    this.statusElement = hud.querySelector<HTMLElement>(".connection")!;
    const panel = hud.querySelector<HTMLElement>(".panel")!;
    this.profilePanel = panel;
    const nameInput = panel.querySelector<HTMLInputElement>("input")!;
    const keyboard = this.input.keyboard!;
    const isTextField = (target: EventTarget | null): boolean => target instanceof HTMLTextAreaElement
      || (target instanceof HTMLInputElement && !["button", "checkbox", "color", "file", "radio", "range", "submit"].includes(target.type));
    const pauseForText = () => {
      keyboard.resetKeys();
      keyboard.disableGlobalCapture();
      keyboard.enabled = false;
      this.moveTarget = null;
      (this.player.body as Phaser.Physics.Arcade.Body).setVelocity(0);
    };
    const resumeAfterText = () => {
      keyboard.resetKeys();
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
    };
    hud.addEventListener("focusin", event => {
      if (isTextField(event.target)) pauseForText();
    });
    hud.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!isTextField(document.activeElement)) resumeAfterText();
      }, 0);
    });
    hud.querySelector<HTMLButtonElement>(".edit")!.onclick = () => {
      this.closeChatComposer(true);
      panel.hidden = !panel.hidden;
      if (panel.hidden) nameInput.blur();
    };
    let selected = this.profile.color;
    panel.querySelectorAll<HTMLButtonElement>(".swatch").forEach(swatch => swatch.onclick = () => { selected = swatch.dataset.color!; panel.querySelectorAll(".swatch").forEach(x => x.classList.toggle("selected", x === swatch)); });
    panel.querySelector<HTMLButtonElement>(".save")!.onclick = () => {
      const username = nameInput.value.trim().slice(0, 18) || "New Neighbor";
      this.profile = { ...this.profile, username, color: selected };
      saveProfile(this.profile);
      this.nameLabel.setText(username);
      this.player.setData("baseColor", selected);
      if (!this.player.getData("messageActive") && !this.composingChat) {
        (this.player.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(Phaser.Display.Color.HexStringToColor(selected).color);
      }
      this.network?.updatePresence(this.profile, this.player.x, this.player.y);
      nameInput.blur();
      panel.hidden = true;
    };
    this.chatForm = hud.querySelector<HTMLFormElement>(".chat-composer")!;
    this.chatInput = this.chatForm.querySelector<HTMLInputElement>("input")!;
    this.chatInput.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeChatComposer(true);
      }
    });
    this.chatForm.addEventListener("submit", event => {
      event.preventDefault();
      this.submitChatMessage();
    });
    this.photoInput = this.chatForm.querySelector<HTMLInputElement>(".photo-input")!;
    this.photoButton = this.chatForm.querySelector<HTMLButtonElement>(".photo-picker")!;
    this.photoButton.addEventListener("click", event => {
      event.stopPropagation();
      this.photoInput?.click();
    });
    this.photoInput.addEventListener("change", () => {
      const file = this.photoInput?.files?.[0];
      if (file) void this.submitPhotoMessage(file);
    });
    const stick = hud.querySelector<HTMLElement>(".joystick")!;
    const knob = stick.querySelector<HTMLElement>(".joystick-knob")!;
    let joystickPointer: number | null = null;
    const moveJoystick = (event: PointerEvent) => {
      if (event.pointerId !== joystickPointer) return;
      event.preventDefault();
      const box = stick.getBoundingClientRect();
      const rawX = event.clientX - (box.left + box.width / 2);
      const rawY = event.clientY - (box.top + box.height / 2);
      this.joystick.set(rawX / 42, rawY / 42).limit(1);
      knob.style.transform = `translate(${this.joystick.x * 31}px, ${this.joystick.y * 31}px)`;
      this.moveTarget = null;
    };
    const startJoystick = (event: PointerEvent) => {
      joystickPointer = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      moveJoystick(event);
    };
    const stopJoystick = (event?: PointerEvent) => {
      if (event && joystickPointer !== null && event.pointerId !== joystickPointer) return;
      joystickPointer = null;
      this.joystick.set(0);
      knob.style.transform = "translate(0, 0)";
    };
    stick.addEventListener("pointerdown", startJoystick);
    window.addEventListener("pointermove", moveJoystick, { passive: false });
    window.addEventListener("pointerup", stopJoystick);
    window.addEventListener("pointercancel", stopJoystick);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("pointermove", moveJoystick);
      window.removeEventListener("pointerup", stopJoystick);
      window.removeEventListener("pointercancel", stopJoystick);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => hud.remove());
  }

  private async startMultiplayer(): Promise<void> {
    this.network = createTownSquareTransport({
      onPlayers: players => this.syncOnlinePlayers(players),
      onMovement: player => this.upsertRemote(player),
      onCorrection: (x, y, velocityX, velocityY, sequence) => this.applyAuthoritativeCorrection(x, y, velocityX, velocityY, sequence),
      onChat: message => this.receiveChatMessage(message),
      onCount: count => this.setOnlineCount(count),
      onStatus: status => this.setConnectionStatus(status),
      onNotice: message => this.showBubble(this.player.x, this.player.y - 55, message),
    });

    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("focus", this.handleNetworkResume);
    window.addEventListener("online", this.handleNetworkResume);
    window.addEventListener("pageshow", this.handleNetworkResume);

    await this.reconnectMultiplayer(true);
  }

  private async reconnectMultiplayer(force = false): Promise<void> {
    if (!this.network || this.reconnecting || document.visibilityState === "hidden" || !navigator.onLine) return;
    if (!force && this.connectionStatus === "online") return;

    this.reconnecting = true;
    try {
      const connectionId = await this.network.connect(this.profile, this.player.x, this.player.y);
      this.profile = { ...this.profile, id: connectionId };
    } catch (error) {
      console.error("Blockaroo multiplayer connection failed", error);
      this.setConnectionStatus("error");
    } finally {
      this.reconnecting = false;
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.wasHidden = true;
      return;
    }
    if (this.wasHidden) {
      this.wasHidden = false;
      void this.reconnectMultiplayer(this.network?.mode === "supabase-fallback");
    }
  };

  private readonly handleNetworkResume = (): void => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      void this.reconnectMultiplayer(this.network?.mode === "supabase-fallback");
    }
  };

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || document.visibilityState === "hidden" || !navigator.onLine) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectMultiplayer();
    }, 1200);
  }

  private syncOnlinePlayers(players: OnlinePlayer[]): void {
    const activeIds = new Set(players.map(player => player.id));
    for (const [id, remote] of this.remotes) {
      if (!activeIds.has(id)) {
        remote.body.destroy(true);
        this.remotes.delete(id);
      }
    }
    for (const player of players) this.upsertRemote(player);
  }

  private upsertRemote(player: OnlinePlayer): void {
    const existing = this.remotes.get(player.id);
    if (existing) {
      if (player.updatedAt < existing.updatedAt) return;
      existing.updatedAt = player.updatedAt;
      existing.target.set(player.x, player.y);
      existing.velocity.set(player.velocityX, player.velocityY);
      existing.zone = player.zone;
      existing.body.setVisible(player.zone === 1);
      existing.body.setData("baseColor", player.color);
      if (!existing.body.getData("messageActive")) {
        (existing.body.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(Phaser.Display.Color.HexStringToColor(player.color).color);
      }
      (existing.body.getAt(1) as Phaser.GameObjects.Text).setText(player.username);
      return;
    }

    const body = this.makePlayer(player, player.x, player.y);
    this.remotes.set(player.id, {
      body,
      target: new Phaser.Math.Vector2(player.x, player.y),
      velocity: new Phaser.Math.Vector2(player.velocityX, player.velocityY),
      updatedAt: player.updatedAt,
      zone: player.zone,
    });
    body.setVisible(player.zone === 1);
  }

  private openChatComposer(): void {
    if (!this.chatForm || !this.chatInput) return;
    this.photoPrepareGeneration += 1;
    this.clearBlockMessage(this.player);
    this.composingChat = true;
    if (this.profilePanel) this.profilePanel.hidden = true;
    (this.player.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(0xffffff);
    this.chatInput.value = "";
    if (this.photoInput) this.photoInput.value = "";
    this.setPhotoPreparing(false);
    this.chatForm.hidden = false;
    this.updateChatComposerPosition();
    window.setTimeout(() => this.chatInput?.focus(), 0);
  }

  private closeChatComposer(restoreColor: boolean): void {
    if (!this.composingChat) return;
    this.photoPrepareGeneration += 1;
    this.composingChat = false;
    if (this.chatForm) this.chatForm.hidden = true;
    if (this.photoInput) this.photoInput.value = "";
    this.setPhotoPreparing(false);
    this.chatInput?.blur();
    const keyboard = this.input.keyboard;
    if (keyboard) {
      keyboard.resetKeys();
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
    }
    if (restoreColor && !this.player.getData("messageActive")) {
      const baseColor = this.player.getData("baseColor") as string;
      (this.player.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(Phaser.Display.Color.HexStringToColor(baseColor).color);
    }
  }

  private submitChatMessage(): void {
    const text = this.chatInput?.value.trim().replace(/\s+/g, " ").slice(0, 120) ?? "";
    if (!text) {
      this.closeChatComposer(true);
      return;
    }

    const message = this.network?.sendChat(this.profile, text, this.player.x, this.player.y);
    this.closeChatComposer(false);
    this.showBlockMessage(this.player, text, message?.durationMs ?? 12_000);
  }

  private async submitPhotoMessage(file: File): Promise<void> {
    if (!this.composingChat) return;
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      this.showBubble(this.player.x, this.player.y - 55, "Choose a JPEG, PNG, or WebP picture.");
      if (this.photoInput) this.photoInput.value = "";
      return;
    }
    if (file.size > MAX_IMAGE_INPUT_BYTES) {
      this.showBubble(this.player.x, this.player.y - 55, "That picture is too large. Choose one under 15 MB.");
      if (this.photoInput) this.photoInput.value = "";
      return;
    }

    const generation = ++this.photoPrepareGeneration;
    this.setPhotoPreparing(true);
    try {
      const imageDataUrl = await this.prepareTemporaryImage(file);
      if (generation !== this.photoPrepareGeneration || !this.composingChat) return;
      const message = await this.network?.sendImage(this.profile, imageDataUrl, this.player.x, this.player.y);
      const messageId = message?.id ?? crypto.randomUUID();
      this.closeChatComposer(false);
      this.showBlockPhoto(this.player, imageDataUrl, messageId, message?.durationMs ?? 12_000);
    } catch (error) {
      console.error("Blockaroo could not prepare the picture", error);
      if (generation === this.photoPrepareGeneration) {
        this.showBubble(this.player.x, this.player.y - 55, "That picture could not be prepared. Try another one.");
        this.setPhotoPreparing(false);
      }
    } finally {
      if (this.photoInput) this.photoInput.value = "";
    }
  }

  private receiveChatMessage(message: BlockChatMessage): void {
    const remaining = message.durationMs - (Date.now() - message.sentAt);
    if (remaining <= 0) return;
    this.upsertRemote(message.player);
    const remote = this.remotes.get(message.player.id);
    if (!remote) return;
    if (message.kind === "image" && this.isSafeTemporaryImage(message.imageDataUrl)) {
      this.showBlockPhoto(remote.body, message.imageDataUrl, message.id, remaining);
      return;
    }
    if (typeof message.text === "string" && message.text.trim()) {
      this.showBlockMessage(remote.body, message.text.slice(0, 120), remaining);
    }
  }

  private showBlockMessage(block: Phaser.GameObjects.Container, text: string, durationMs: number): void {
    this.clearBlockMessage(block);
    const messageText = this.add.text(0, 0, text, {
      fontFamily: "system-ui",
      fontSize: "15px",
      color: "#0b1020",
      align: "center",
      wordWrap: { width: 220, useAdvancedWrap: true },
    }).setOrigin(.5);
    block.add(messageText);

    const width = Phaser.Math.Clamp(Math.ceil(messageText.width + 24), 58, 250);
    const height = Phaser.Math.Clamp(Math.ceil(messageText.height + 20), 48, 150);
    this.activateBlockMessage(block, messageText, width, height, durationMs);
  }

  private showBlockPhoto(block: Phaser.GameObjects.Container, imageDataUrl: string, messageId: string, durationMs: number): void {
    this.clearBlockMessage(block);
    const square = block.getAt(0) as Phaser.GameObjects.Rectangle;
    const label = block.getAt(1) as Phaser.GameObjects.Text;
    square.setFillStyle(0xffffff).setDisplaySize(70, 70);
    label.setY(-50);
    block.setSize(70, 70);
    block.setData("messageActive", true);
    block.setData("messageId", messageId);

    const browserImage = new window.Image();
    browserImage.onload = () => {
      if (!block.active || block.getData("messageId") !== messageId) return;
      const textureKey = `block-photo-${messageId}`;
      if (this.textures.exists(textureKey)) this.textures.remove(textureKey);
      this.textures.addImage(textureKey, browserImage);
      const photo = this.add.image(0, 0, textureKey).setOrigin(.5);
      block.add(photo);

      const fitScale = Math.min(234 / browserImage.naturalWidth, 190 / browserImage.naturalHeight);
      const imageWidth = Math.max(1, Math.round(browserImage.naturalWidth * fitScale));
      const imageHeight = Math.max(1, Math.round(browserImage.naturalHeight * fitScale));
      photo.setDisplaySize(imageWidth, imageHeight);
      this.activateBlockMessage(block, photo, Math.max(72, imageWidth + 16), Math.max(72, imageHeight + 16), durationMs, textureKey);
    };
    browserImage.onerror = () => {
      if (block.active && block.getData("messageId") === messageId) {
        this.showBlockMessage(block, "Picture unavailable", Math.min(durationMs, 2_500));
      }
    };
    browserImage.src = imageDataUrl;
  }

  private activateBlockMessage(
    block: Phaser.GameObjects.Container,
    content: Phaser.GameObjects.Text | Phaser.GameObjects.Image,
    width: number,
    height: number,
    durationMs: number,
    textureKey?: string,
  ): void {
    const square = block.getAt(0) as Phaser.GameObjects.Rectangle;
    const label = block.getAt(1) as Phaser.GameObjects.Text;
    square.setFillStyle(0xffffff).setDisplaySize(width, height);
    label.setY(-(height / 2) - 15);
    block.setSize(width, height);
    block.setData("messageActive", true);
    block.setData("messageContent", content);
    block.setData("messageTextureKey", textureKey ?? null);

    const fadeDuration = Math.min(900, Math.max(300, durationMs * 0.25));
    const timer = this.time.delayedCall(Math.max(0, durationMs - fadeDuration), () => {
      const baseColor = Phaser.Display.Color.HexStringToColor(block.getData("baseColor") as string);
      const white = Phaser.Display.Color.ValueToColor(0xffffff);
      const fadeTween = this.tweens.addCounter({
        from: 0,
        to: 100,
        duration: fadeDuration,
        ease: "Sine.easeInOut",
        onUpdate: tween => {
          const progress = (tween.getValue() ?? 0) / 100;
          const color = Phaser.Display.Color.Interpolate.ColorWithColor(white, baseColor, 100, progress * 100);
          square.setFillStyle(Phaser.Display.Color.GetColor(color.r, color.g, color.b));
          square.setDisplaySize(Phaser.Math.Linear(width, 42, progress), Phaser.Math.Linear(height, 42, progress));
          label.setY(Phaser.Math.Linear(-(height / 2) - 15, -39, progress));
          content.setAlpha(1 - progress);
        },
        onComplete: () => {
          block.setData("messageTween", null);
          this.clearBlockMessage(block);
        },
      });
      block.setData("messageTween", fadeTween);
    });
    block.setData("messageTimer", timer);
  }

  private clearBlockMessage(block: Phaser.GameObjects.Container): void {
    const square = block.getAt(0) as Phaser.GameObjects.Rectangle;
    const label = block.getAt(1) as Phaser.GameObjects.Text;
    const timer = block.getData("messageTimer") as Phaser.Time.TimerEvent | undefined;
    const fadeTween = block.getData("messageTween") as Phaser.Tweens.Tween | undefined;
    const messageContent = block.getData("messageContent") as Phaser.GameObjects.Text | Phaser.GameObjects.Image | undefined;
    const textureKey = block.getData("messageTextureKey") as string | undefined;
    timer?.remove(false);
    fadeTween?.stop();
    if (messageContent) {
      this.tweens.killTweensOf(messageContent);
      messageContent.destroy();
    }
    if (textureKey && this.textures.exists(textureKey)) this.textures.remove(textureKey);
    this.tweens.killTweensOf(square);
    square.setDisplaySize(42, 42).setAlpha(1);
    const baseColor = block.getData("baseColor") as string;
    square.setFillStyle(Phaser.Display.Color.HexStringToColor(baseColor).color);
    label.setY(-39).setAlpha(1);
    block.setSize(42, 42);
    block.setData("messageActive", false);
    block.setData("messageId", null);
    block.setData("messageContent", null);
    block.setData("messageTextureKey", null);
    block.setData("messageTimer", null);
    block.setData("messageTween", null);
  }

  private setPhotoPreparing(preparing: boolean): void {
    if (this.photoButton) {
      this.photoButton.disabled = preparing;
      this.photoButton.setAttribute("aria-busy", String(preparing));
    }
    this.chatForm?.classList.toggle("is-preparing-photo", preparing);
  }

  private async prepareTemporaryImage(file: File): Promise<string> {
    const objectUrl = URL.createObjectURL(file);
    const source = new window.Image();
    try {
      await new Promise<void>((resolve, reject) => {
        source.onload = () => resolve();
        source.onerror = () => reject(new Error("The selected file is not a readable picture."));
        source.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }

    if (!source.naturalWidth || !source.naturalHeight) throw new Error("The picture has no dimensions.");
    let maxDimension = 512;
    const qualities = [0.78, 0.66, 0.54, 0.42];

    for (let sizeAttempt = 0; sizeAttempt < 5; sizeAttempt += 1) {
      const scale = Math.min(1, maxDimension / Math.max(source.naturalWidth, source.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot resize pictures.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, canvas.width, canvas.height);

      for (const quality of qualities) {
        const imageDataUrl = canvas.toDataURL("image/jpeg", quality);
        if (imageDataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) return imageDataUrl;
      }
      maxDimension = Math.max(300, Math.floor(maxDimension * 0.78));
    }

    throw new Error("The compressed picture is still too large for temporary chat.");
  }

  private isSafeTemporaryImage(value: unknown): value is string {
    if (typeof value !== "string") return false;
    if (value.length <= MAX_IMAGE_DATA_URL_CHARS && value.startsWith("data:image/jpeg;base64,")) return true;
    if (value.length > 4096) return false;
    try {
      const imageUrl = new URL(value);
      const allowedOrigins = [
        import.meta.env.VITE_WORLD_SOCKET_URL as string | undefined,
        import.meta.env.VITE_SUPABASE_URL as string | undefined,
      ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
        .map(candidate => new URL(candidate.trim()).origin);
      const secureOrLocal = imageUrl.protocol === "https:"
        || (imageUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(imageUrl.hostname));
      return secureOrLocal && allowedOrigins.includes(imageUrl.origin);
    } catch {
      return false;
    }
  }

  private applyAuthoritativeCorrection(x: number, y: number, _velocityX: number, _velocityY: number, _sequence: number): void {
    const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, x, y);
    if (distance > 160) {
      this.player.setPosition(x, y);
      this.localCorrection = null;
    } else if (distance > 4) {
      this.localCorrection = new Phaser.Math.Vector2(x - this.player.x, y - this.player.y);
    }
  }

  private updateChatComposerPosition(): void {
    if (!this.chatForm || this.chatForm.hidden) return;
    const camera = this.cameras.main;
    const screenX = (this.player.x - camera.worldView.x) * camera.zoom + camera.x;
    const screenY = (this.player.y - camera.worldView.y) * camera.zoom + camera.y;
    const horizontalMargin = (this.chatForm.offsetWidth / 2) + 8;
    this.chatForm.style.left = `${Phaser.Math.Clamp(screenX, horizontalMargin, this.scale.width - horizontalMargin)}px`;
    this.chatForm.style.top = `${Phaser.Math.Clamp(screenY - 72, 70, this.scale.height - 90)}px`;
  }

  private setConnectionStatus(status: "connecting" | "online" | "offline" | "error"): void {
    this.connectionStatus = status;
    if (!this.statusElement) return;
    this.statusElement.className = `connection is-${status}`;
    this.statusElement.textContent = status === "online" ? `Live · ${this.onlineCount} online` : status === "connecting" ? "Connecting…" : status === "offline" ? "Offline" : "Connection error";
    if (status === "offline" || status === "error") this.scheduleReconnect();
  }

  private setOnlineCount(count: number): void {
    this.onlineCount = Math.max(1, count);
    if (this.statusElement?.classList.contains("is-online")) {
      this.statusElement.textContent = `Live · ${this.onlineCount} online`;
    }
  }

  private showBubble(x: number, y: number, text: string): void {
    const bubble = this.add.text(x, y, text, { fontFamily: "system-ui", fontSize: "14px", color: "#182033", backgroundColor: "#fff9e8", padding: { x: 10, y: 7 }, wordWrap: { width: 210 } }).setOrigin(.5).setDepth(999);
    this.tweens.add({ targets: bubble, y: y - 16, alpha: 0, delay: 2500, duration: 500, onComplete: () => bubble.destroy() });
  }

  private escape(value: string): string { return value.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!); }
}
