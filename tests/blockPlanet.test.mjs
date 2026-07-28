import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_PLANET_SLOTS,
  demoBlockPlanetPage,
  hasDemoBlockPlanetPage,
  isBlockPlanetSwipe,
  nextBlockPlanetSlotIndex,
} from "../src/social/blockPlanet.ts";

test("the Block Planet has twenty unique post slots around one permanent core", () => {
  assert.equal(BLOCK_PLANET_SLOTS.length, 20);
  assert.equal(new Set(BLOCK_PLANET_SLOTS.map(slot => `${slot.column}:${slot.row}`)).size, 20);
  assert.equal(BLOCK_PLANET_SLOTS.some(slot => slot.column === 3 && slot.row === 3), false);
  assert.equal(BLOCK_PLANET_SLOTS.some(slot => [1, 5].includes(slot.column) && [1, 5].includes(slot.row)), false);
  assert.equal(BLOCK_PLANET_SLOTS.filter(slot => slot.ring === 1).length, 8);
  assert.equal(BLOCK_PLANET_SLOTS.filter(slot => slot.ring === 2).length, 12);
});

test("guest demo posts arrive in feed-sized pages and stop at the real edge", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const first = demoBlockPlanetPage(0, now);
  const second = demoBlockPlanetPage(1, now);
  assert.equal(first.length, 20);
  assert.equal(second.length, 20);
  assert.equal(new Set([...first, ...second].map(post => post.id)).size, 40);
  assert.equal(hasDemoBlockPlanetPage(0), true);
  assert.equal(hasDemoBlockPlanetPage(1), true);
  assert.equal(hasDemoBlockPlanetPage(2), false);
  assert.deepEqual(demoBlockPlanetPage(2, now), []);
});

test("orbit changes require a deliberate swipe", () => {
  assert.equal(isBlockPlanetSwipe(40, 40), false);
  assert.equal(isBlockPlanetSwipe(72, 0), true);
  assert.equal(isBlockPlanetSwipe(-60, -60), true);
});

test("arrow navigation moves to the nearest block in the requested direction", () => {
  const start = BLOCK_PLANET_SLOTS.findIndex(slot => slot.column === 3 && slot.row === 2);
  const left = nextBlockPlanetSlotIndex(start, "ArrowLeft");
  const up = nextBlockPlanetSlotIndex(start, "ArrowUp");
  assert.deepEqual(BLOCK_PLANET_SLOTS[left], { column: 2, row: 2, ring: 1 });
  assert.deepEqual(BLOCK_PLANET_SLOTS[up], { column: 3, row: 1, ring: 2 });
});
