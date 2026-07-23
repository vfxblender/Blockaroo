import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const ORIGIN = "http://localhost:5173";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function environment() {
  return {
    ALLOWED_ORIGINS: ORIGIN,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    TICKET_SECRET: "ticket-secret-that-is-at-least-32-characters",
    MEDIA_SECRET: "media-secret-that-is-at-least-32-characters",
  };
}

test("health and CORS expose the complete test surface", async () => {
  const env = environment();
  const health = await worker.fetch(new Request("https://world.example/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "blockaroo-world",
    protocol: 2,
  });

  const preflight = await worker.fetch(new Request("https://world.example/account", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN },
  }), env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /\bDELETE\b/);
});

test("session tickets are bound to the one active Town Square", async () => {
  const env = environment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: USER_ID, is_anonymous: true });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  try {
    const unavailable = await worker.fetch(new Request("https://world.example/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-session",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({ cityId: "nashville", spaceId: "made-up-room" }),
    }), env);
    assert.equal(unavailable.status, 404);

    const session = await worker.fetch(new Request("https://world.example/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-session",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({ cityId: "nashville", spaceId: "town-square" }),
    }), env);
    assert.equal(session.status, 200);
    const { ticket } = await session.json();
    assert.equal(typeof ticket, "string");

    const wrongSpace = await worker.fetch(new Request(
      `https://world.example/world/nashville/not-town-square?ticket=${encodeURIComponent(ticket)}`,
      { headers: { Origin: ORIGIN, Upgrade: "websocket" } },
    ), env);
    assert.equal(wrongSpace.status, 401);
    assert.equal((await wrongSpace.json()).error, "The world ticket does not match this space.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
