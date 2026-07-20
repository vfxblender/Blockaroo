import assert from "node:assert/strict";
import test from "node:test";
import { ServerClock } from "../src/game/systems/ServerClock.ts";

test("a pong removes browser/server clock skew", () => {
  const clock = new ServerClock();

  // The browser clock is 5 seconds ahead. The ping takes 100 ms round trip.
  clock.observeWelcome(5_000, 10_100);
  assert.equal(clock.observePong(10_000, 5_050, 10_100), true);
  assert.equal(clock.estimatedOffsetMs, -5_000);
  assert.equal(clock.toServerTime(12_000), 7_000);
  assert.equal(clock.toLocalTime(8_000), 13_000);
});

test("invalid or excessively late pong samples are ignored", () => {
  const clock = new ServerClock();
  clock.observeWelcome(20_000, 20_250);

  assert.equal(clock.observePong(20_000, 20_100, 31_000), false);
  assert.equal(clock.estimatedOffsetMs, -250);
});
