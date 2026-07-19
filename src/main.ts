import Phaser from "phaser";
import "./styles.css";
import { TownSquareScene } from "./game/scenes/TownSquareScene";

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#10182b",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [TownSquareScene],
});
