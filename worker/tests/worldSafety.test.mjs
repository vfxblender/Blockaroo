import assert from "node:assert/strict";
import test from "node:test";
import { hasBlockBetween } from "../src/worldSafety.ts";

const ALICE = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  blockedUserIds: [],
};
const BOB = {
  authUserId: "22222222-2222-4222-8222-222222222222",
  blockedUserIds: [],
};

test("world blocking is reciprocal when either participant blocks the other", () => {
  assert.equal(hasBlockBetween(ALICE, BOB), false);
  assert.equal(hasBlockBetween(
    { ...ALICE, blockedUserIds: [BOB.authUserId] },
    BOB,
  ), true);
  assert.equal(hasBlockBetween(
    ALICE,
    { ...BOB, blockedUserIds: [ALICE.authUserId] },
  ), true);
});
