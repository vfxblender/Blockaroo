import Phaser from "phaser";
import { PALETTE, WORLD } from "../config";
import { loadProfile, saveProfile } from "../systems/LocalProfile";
import { RealtimeTownSquare, type OnlinePlayer } from "../systems/RealtimeTownSquare";
import { WorldRouter } from "../systems/WorldRouter";
import type { PlayerIdentity } from "../types/world";

type Remote = { body: Phaser.GameObjects.Container; target: Phaser.Math.Vector2 };

export class TownSquareScene extends Phaser.Scene {
  private profile = loadProfile();
  private player!: Phaser.GameObjects.Container;
  private nameLabel!: Phaser.GameObjects.Text;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private joystick = new Phaser.Math.Vector2();
  private moveTarget: Phaser.Math.Vector2 | null = null;
  private remotes = new Map<string, Remote>();
  private network: RealtimeTownSquare | null = null;
  private statusElement: HTMLElement | null = null;
  private lastBroadcastAt = 0;
  private lastPresenceAt = 0;
  private onlineCount = 1;
  private router = new WorldRouter();

  constructor() { super("TownSquare"); }

  create(): void {
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.drawWorld();
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
      this.moveTarget = new Phaser.Math.Vector2(pointer.worldX, pointer.worldY);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      void this.network?.disconnect();
      for (const remote of this.remotes.values()) remote.body.destroy(true);
      this.remotes.clear();
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

    if (time - this.lastBroadcastAt >= 80 && body.speed > 0) {
      this.network?.sendMovement(this.profile, this.player.x, this.player.y);
      this.lastBroadcastAt = time;
    }
    if (time - this.lastPresenceAt >= 2500) {
      this.network?.updatePresence(this.profile, this.player.x, this.player.y);
      this.lastPresenceAt = time;
    }

    const blend = 1 - Math.exp(-delta * 0.012);
    for (const remote of this.remotes.values()) {
      remote.body.x = Phaser.Math.Linear(remote.body.x, remote.target.x, blend);
      remote.body.y = Phaser.Math.Linear(remote.body.y, remote.target.y, blend);
      remote.body.setDepth(remote.body.y);
    }
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

  private makePlayer(identity: PlayerIdentity, x: number, y: number, local = false): Phaser.GameObjects.Container {
    const square = this.add.rectangle(0, 0, 42, 42, Phaser.Display.Color.HexStringToColor(identity.color).color, 1).setStrokeStyle(3, 0x0b1020, 1).setInteractive({ useHandCursor: !local });
    const label = this.add.text(0, -39, identity.username, { fontFamily: "system-ui", fontSize: "13px", color: "#ffffff", stroke: "#17223a", strokeThickness: 4 }).setOrigin(.5);
    const block = this.add.container(x, y, [square, label]);
    block.setSize(42, 42);
    block.setDepth(y);
    if (!local) {
      square.on("pointerdown", (_pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
        this.moveTarget = null;
        const currentName = (block.getAt(1) as Phaser.GameObjects.Text).text;
        this.showBubble(block.x, block.y - 50, `${currentName} is online. Nearby chat comes next.`);
      });
    }
    return block;
  }

  private createHud(): void {
    const hud = document.createElement("section");
    hud.className = "hud";
    hud.innerHTML = `<div class="topbar"><div class="brand">BLOCKAROO<small>Nashville · Town Square</small><span class="connection is-connecting">Connecting…</span></div><button class="edit">Your block</button></div><aside class="panel" hidden><h2>Your block</h2><label class="field">Display name<input maxlength="18" value="${this.escape(this.profile.username)}" /></label><label class="field">Block color<div class="swatches">${PALETTE.map(c => `<button class="swatch ${c === this.profile.color ? "selected" : ""}" aria-label="Choose color" style="background:${c}" data-color="${c}"></button>`).join("")}</div></label><button class="save">Enter Town Square</button></aside><div class="hint">WASD / arrows · click or tap the ground · drag the joystick</div><div class="joystick" aria-label="Movement joystick"><span class="joystick-knob"></span></div>`;
    document.body.append(hud);
    this.statusElement = hud.querySelector<HTMLElement>(".connection")!;
    const panel = hud.querySelector<HTMLElement>(".panel")!;
    const nameInput = panel.querySelector<HTMLInputElement>("input")!;
    const keyboard = this.input.keyboard!;
    nameInput.addEventListener("focus", () => {
      keyboard.disableGlobalCapture();
      keyboard.enabled = false;
      this.moveTarget = null;
      (this.player.body as Phaser.Physics.Arcade.Body).setVelocity(0);
    });
    nameInput.addEventListener("blur", () => {
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
    });
    hud.querySelector<HTMLButtonElement>(".edit")!.onclick = () => {
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
      (this.player.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(Phaser.Display.Color.HexStringToColor(selected).color);
      this.network?.updatePresence(this.profile, this.player.x, this.player.y);
      nameInput.blur();
      panel.hidden = true;
    };
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
    this.network = new RealtimeTownSquare({
      onPlayers: players => this.syncOnlinePlayers(players),
      onMovement: player => this.upsertRemote(player),
      onCount: count => this.setOnlineCount(count),
      onStatus: status => this.setConnectionStatus(status),
    });

    try {
      const connectionId = await this.network.connect(this.profile, this.player.x, this.player.y);
      this.profile = { ...this.profile, id: connectionId };
    } catch (error) {
      console.error("Blockaroo multiplayer connection failed", error);
      this.setConnectionStatus("error");
    }
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
      existing.target.set(player.x, player.y);
      (existing.body.getAt(0) as Phaser.GameObjects.Rectangle).setFillStyle(Phaser.Display.Color.HexStringToColor(player.color).color);
      (existing.body.getAt(1) as Phaser.GameObjects.Text).setText(player.username);
      return;
    }

    const body = this.makePlayer(player, player.x, player.y);
    this.remotes.set(player.id, {
      body,
      target: new Phaser.Math.Vector2(player.x, player.y),
    });
  }

  private setConnectionStatus(status: "connecting" | "online" | "offline" | "error"): void {
    if (!this.statusElement) return;
    this.statusElement.className = `connection is-${status}`;
    this.statusElement.textContent = status === "online" ? `Live · ${this.onlineCount} online` : status === "connecting" ? "Connecting…" : status === "offline" ? "Offline" : "Connection error";
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
