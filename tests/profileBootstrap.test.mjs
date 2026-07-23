import assert from "node:assert/strict";
import test from "node:test";
import { createOrLoadProfile } from "../src/services/profileBootstrap.ts";

test("a concurrent profile insert recovers by loading the winning row", async () => {
  const winner = { userId: "winner" };
  let loadCount = 0;

  const profile = await createOrLoadProfile(
    async () => ({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    }),
    async () => {
      loadCount += 1;
      return winner;
    },
  );

  assert.equal(profile, winner);
  assert.equal(loadCount, 1);
});

test("profile creation still rejects unrelated database errors", async () => {
  const failure = { code: "42501", message: "row-level security denied the insert" };

  await assert.rejects(
    createOrLoadProfile(
      async () => ({ data: null, error: failure }),
      async () => ({ userId: "should-not-load" }),
    ),
    error => error === failure,
  );
});
