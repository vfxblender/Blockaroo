import type { PlayerIdentity } from "../types/world";

export interface LocalTownNeighbor {
  identity: PlayerIdentity;
  orbitRadius: number;
  phase: number;
  speed: number;
}

// These town guides are deterministic scenery, so every browser can animate
// them locally without spending a single presence or movement packet.
export const LOCAL_TOWN_NEIGHBORS: LocalTownNeighbor[] = [
  { identity: { id: "local:kai", username: "Kai", color: "#ff6b6b" }, orbitRadius: 370, phase: 0.2, speed: 0.000026 },
  { identity: { id: "local:sol", username: "Sol", color: "#06d6a0" }, orbitRadius: 410, phase: 2.55, speed: 0.000021 },
  { identity: { id: "local:luna", username: "Luna", color: "#a78bfa" }, orbitRadius: 335, phase: 4.25, speed: 0.000029 },
  { identity: { id: "local:miles", username: "Miles", color: "#ffd166" }, orbitRadius: 450, phase: 1.45, speed: 0.000018 },
];
