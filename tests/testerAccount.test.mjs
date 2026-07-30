import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isTesterAccountEmail,
  normalizeAccountEmail,
  parseTesterSession,
} from "../src/services/testerAccount.ts";

test("tester aliases are normalized and limited to the private tester domain", () => {
  assert.equal(
    normalizeAccountEmail("  TESTER-ONE@BLOCKAROO.TEST "),
    "tester-one@blockaroo.test",
  );
  assert.equal(isTesterAccountEmail("tester-one@blockaroo.test"), true);
  assert.equal(isTesterAccountEmail("tester-one@sub.blockaroo.test"), false);
  assert.equal(isTesterAccountEmail("tester-one@blockaroo.test.example.com"), false);
  assert.equal(isTesterAccountEmail("tester-one@@blockaroo.test"), false);
});

test("only a complete tester session response is accepted", () => {
  assert.deepEqual(
    parseTesterSession({
      tester: true,
      session: {
        access_token: "access",
        refresh_token: "refresh",
      },
    }),
    {
      access_token: "access",
      refresh_token: "refresh",
    },
  );
  assert.equal(parseTesterSession({ tester: false }), null);
  assert.equal(parseTesterSession({ tester: true, session: { access_token: "access" } }), null);
});

test("the server keeps tester aliases and credentials out of the public source", async () => {
  const source = await readFile(
    new URL("../supabase/functions/tester-login/index.ts", import.meta.url),
    "utf8",
  );
  const config = await readFile(
    new URL("../supabase/config.toml", import.meta.url),
    "utf8",
  );

  assert.match(source, /emailHash:/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /auth\.admin\.createUser/);
  assert.match(source, /signInWithPassword/);
  assert.match(source, /Cache-Control": "no-store"/);
  assert.doesNotMatch(source, /tester-(?:one|two)-[0-9a-f]{20}@blockaroo\.test/i);
  assert.match(config, /\[functions\.tester-login\][\s\S]*verify_jwt = true/);
});
