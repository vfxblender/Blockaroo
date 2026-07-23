import type { CircleGame } from "../../shared/worldProtocol";

export interface CircleGameAvailability {
  canStart: boolean;
  reason: string;
}

export function circleGameAvailability(game: CircleGame, memberCount: number): CircleGameAvailability {
  if (memberCount < 2) {
    return { canStart: false, reason: "Needs 2 players" };
  }
  if (game === "bluff" && memberCount < 4) {
    return { canStart: false, reason: "Needs 4 players" };
  }
  return { canStart: true, reason: "" };
}
