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

test("the Block Planet has eight unique stacks around one permanent core", () => {
  assert.equal(BLOCK_PLANET_SLOTS.length, 8);
  assert.equal(new Set(BLOCK_PLANET_SLOTS.map(slot => `${slot.column}:${slot.row}`)).size, 8);
  assert.equal(BLOCK_PLANET_SLOTS.some(slot => slot.column === 2 && slot.row === 2), false);
  assert.equal(BLOCK_PLANET_SLOTS.every(slot => [1, 2, 3].includes(slot.column) && [1, 2, 3].includes(slot.row)), true);
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

test("twenty posts are dealt beneath eight visible stack tops", () => {
  const posts = demoBlockPlanetPage(0, Date.parse("2026-07-27T12:00:00Z"));
  const stacks = buildBlockPlanetStacks(posts);
  assert.deepEqual(stacks.map(stack => stack.length), [3, 3, 3, 3, 2, 2, 2, 2]);
  assert.deepEqual(stacks.map(stack => stack[0]?.id), posts.slice(0, 8).map(post => post.id));

  const dismissed = new Set([posts[0].id, posts[8].id]);
  const afterDismiss = buildBlockPlanetStacks(posts, dismissed);
  assert.equal(afterDismiss[0][0]?.id, posts[16].id);
  assert.equal(afterDismiss.flat().length, 18);
});

test("multiple feed batches remain one continuous eight-stack wall", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const posts = [...demoBlockPlanetPage(0, now), ...demoBlockPlanetPage(1, now)];
  const stacks = buildBlockPlanetStacks(posts);
  assert.deepEqual(stacks.map(stack => stack.length), [5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(stacks.flat().length, 40);
});

test("sending one post to orbit requires a deliberate drag", () => {
  assert.equal(isBlockPlanetDismiss(40, 40), false);
  assert.equal(isBlockPlanetDismiss(88, 0), true);
  assert.equal(isBlockPlanetDismiss(-64, -64), true);
});

test("arrow navigation moves to the nearest block in the requested direction", () => {
  const start = BLOCK_PLANET_SLOTS.findIndex(slot => slot.column === 2 && slot.row === 1);
  const left = nextBlockPlanetSlotIndex(start, "ArrowLeft");
  const down = nextBlockPlanetSlotIndex(start, "ArrowDown");
  assert.deepEqual(BLOCK_PLANET_SLOTS[left], { column: 1, row: 1 });
  assert.deepEqual(BLOCK_PLANET_SLOTS[down], { column: 2, row: 3 });
});
