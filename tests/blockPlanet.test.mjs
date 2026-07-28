import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_PLANET_SLOTS,
  buildBlockPlanetStacks,
  demoBlockPlanetPage,
  hasDemoBlockPlanetPage,
  isBlockPlanetDismiss,
  nextBlockPlanetSlotIndex,
} from "../src/social/blockPlanet.ts";

test("the BlockWall has four unique slots in a 2x2 grid", () => {
  assert.equal(BLOCK_PLANET_SLOTS.length, 4);
  assert.equal(new Set(BLOCK_PLANET_SLOTS.map(slot => `${slot.column}:${slot.row}`)).size, 4);
  assert.equal(BLOCK_PLANET_SLOTS.every(slot => [1, 2].includes(slot.column) && [1, 2].includes(slot.row)), true);
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

test("twenty posts are dealt beneath four visible stack tops", () => {
  const posts = demoBlockPlanetPage(0, Date.parse("2026-07-27T12:00:00Z"));
  const stacks = buildBlockPlanetStacks(posts);
  assert.deepEqual(stacks.map(stack => stack.length), [5, 5, 5, 5]);
  assert.deepEqual(stacks.map(stack => stack[0]?.id), posts.slice(0, 4).map(post => post.id));

  const dismissed = new Set([posts[0].id, posts[4].id]);
  const afterDismiss = buildBlockPlanetStacks(posts, dismissed);
  assert.equal(afterDismiss[0][0]?.id, posts[8].id);
  assert.equal(afterDismiss.flat().length, 18);
});

test("multiple feed batches remain one continuous four-stack wall", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const posts = [...demoBlockPlanetPage(0, now), ...demoBlockPlanetPage(1, now)];
  const stacks = buildBlockPlanetStacks(posts);
  assert.deepEqual(stacks.map(stack => stack.length), [10, 10, 10, 10]);
  assert.equal(stacks.flat().length, 40);
});

test("sending one post to orbit requires a deliberate drag", () => {
  assert.equal(isBlockPlanetDismiss(40, 40), false);
  assert.equal(isBlockPlanetDismiss(88, 0), true);
  assert.equal(isBlockPlanetDismiss(-64, -64), true);
});

test("arrow navigation moves to the nearest block in the requested direction", () => {
  const start = BLOCK_PLANET_SLOTS.findIndex(slot => slot.column === 1 && slot.row === 1);
  const right = nextBlockPlanetSlotIndex(start, "ArrowRight");
  const down = nextBlockPlanetSlotIndex(start, "ArrowDown");
  assert.deepEqual(BLOCK_PLANET_SLOTS[right], { column: 2, row: 1 });
  assert.deepEqual(BLOCK_PLANET_SLOTS[down], { column: 1, row: 2 });
});
