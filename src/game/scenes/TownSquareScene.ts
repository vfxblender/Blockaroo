import Phaser from "phaser";
import { PALETTE, WORLD } from "../config";
import { loadProfile, saveProfile } from "../systems/LocalProfile";
import { WorldRouter } from "../systems/WorldRouter";
import type { PlayerIdentity } from "../types/world";

type Remote = { body: Phaser.GameObjects.Container; target: Phaser.Math.Vector2; label: string };

export class TownSquareScene extends Phaser.Scene {
  private profile = loadProfile();
  private player!: Phaser.GameObjects.Container;
  private nameLabel!: Phaser.GameObjects.Text;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private joystick = new Phaser.Math.Vector2();
  private moveTarget: Phaser.Math.Vector2 | null = null;
  private remotes: Remote[] = [];
  private router = new WorldRouter();

  constructor() { super("TownSquare"); }

  create(): void {
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.drawWorld();
    this.player = this.makePlayer(this.profile, 1090, 760, true);
    this.nameLabel = this.player.getAt(1) as Phaser.GameObjects.Text;
    this.physics.add.existing(this.player);
    (this.player.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setZoom(Phaser.Math.Clamp(Math.min(this.scale.width / 720, this.scale.height / 500), 0.72, 1.15));

    this.cursors = this.input.keyboard!.createCursorKeys();
    // Keep WASD available to normal browser text fields. Movement still reads
    // the key state, but Phaser must not call preventDefault for these letters.
    this.keys = this.input.keyboard!.addKeys("W,A,S,D", false) as Record<string, Phaser.Input.Keyboard.Key>;
    this.createDemoNeighbors();
    this.createHud();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.moveTarget = new Phaser.Math.Vector2(pointer.worldX, pointer.worldY);
    });
  }

  update(_time: number, delta: number): void {
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

    for (const remote of this.remotes) remote.body.x = Phaser.Math.Linear(remote.body.x, remote.target.x, delta * 0.00055), remote.body.y = Phaser.Math.Linear(remote.body.y, remote.target.y, delta * 0.00055);
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
        this.showBubble(block.x, block.y - 50, `Say hi to ${identity.username} — live chat comes with multiplayer.`);
      });
    }
    return block;
  }

  private createDemoNeighbors(): void {
    const neighbors = [
      { id: "luna", username: "Luna", color: PALETTE[4], x: 730, y: 600 },
      { id: "miles", username: "Miles", color: PALETTE[1], x: 1490, y: 850 },
      { id: "sol", username: "Sol", color: PALETTE[2], x: 840, y: 1080 },
      { id: "kai", username: "Kai", color: PALETTE[0], x: 1430, y: 450 },
    ];
    for (const neighbor of neighbors) {
      const body = this.makePlayer(neighbor, neighbor.x, neighbor.y);
      this.remotes.push({ body, label: neighbor.username, target: new Phaser.Math.Vector2(neighbor.x, neighbor.y) });
      this.time.addEvent({ delay: Phaser.Math.Between(2500, 5000), loop: true, callback: () => this.remotes.find(r => r.body === body)!.target.set(Phaser.Math.Between(520, 1680), Phaser.Math.Between(360, 1160)) });
    }
  }

  private createHud(): void {
    const hud = document.createElement("section");
    hud.className = "hud";
    hud.innerHTML = `<div class="topbar"><div class="brand">BLOCKAROO<small>Nashville · Town Square</small></div><button class="edit">Your block</button></div><aside class="panel" hidden><h2>Your block</h2><label class="field">Display name<input maxlength="18" value="${this.escape(this.profile.username)}" /></label><label class="field">Block color<div class="swatches">${PALETTE.map(c => `<button class="swatch ${c === this.profile.color ? "selected" : ""}" aria-label="Choose color" style="background:${c}" data-color="${c}"></button>`).join("")}</div></label><button class="save">Enter Town Square</button></aside><div class="hint">WASD / arrows · click or tap the ground · drag the joystick</div><div class="joystick" aria-label="Movement joystick"><span class="joystick-knob"></span></div>`;
    document.body.append(hud);
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

  private showBubble(x: number, y: number, text: string): void {
    const bubble = this.add.text(x, y, text, { fontFamily: "system-ui", fontSize: "14px", color: "#182033", backgroundColor: "#fff9e8", padding: { x: 10, y: 7 }, wordWrap: { width: 210 } }).setOrigin(.5).setDepth(999);
    this.tweens.add({ targets: bubble, y: y - 16, alpha: 0, delay: 2500, duration: 500, onComplete: () => bubble.destroy() });
  }

  private escape(value: string): string { return value.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!); }
}
