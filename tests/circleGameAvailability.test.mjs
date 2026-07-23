import assert from "node:assert/strict";
import test from "node:test";
import { circleGameAvailability } from "../src/circles/gameAvailability.ts";

test("Circle game controls mirror the server player limits", () => {
  assert.equal(circleGameAvailability("cards", 1).canStart, false);
  assert.equal(circleGameAvailability("cards", 2).canStart, true);
  assert.equal(circleGameAvailability("draw", 6).canStart, true);
  assert.equal(circleGameAvailability("bluff", 3).reason, "Needs 4 players");
  assert.equal(circleGameAvailability("bluff", 4).canStart, true);
  assert.equal(circleGameAvailability("square-off", 4).canStart, true);
  assert.equal(circleGameAvailability("square-off", 5).canStart, true);
});
