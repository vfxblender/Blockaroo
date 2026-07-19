import { PALETTE } from "../config";
import type { PlayerIdentity } from "../types/world";

const STORAGE_KEY = "blockaroo.profile";

export function loadProfile(): PlayerIdentity {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return JSON.parse(saved) as PlayerIdentity;

  const profile = {
    id: crypto.randomUUID(),
    username: "New Neighbor",
    color: PALETTE[0],
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  return profile;
}

export function saveProfile(profile: PlayerIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}
