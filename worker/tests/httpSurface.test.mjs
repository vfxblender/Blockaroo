import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const ORIGIN = "http://localhost:5173";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const FRIEND_ID = "55555555-5555-4555-8555-555555555555";
const STRANGER_ID = "66666666-6666-4666-8666-666666666666";

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

test("session tickets are bound to one of the four Portal rooms", async () => {
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

    const filmDistrict = await worker.fetch(new Request("https://world.example/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-session",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({ cityId: "nashville", spaceId: "film-district" }),
    }), env);
    assert.equal(filmDistrict.status, 200);

    const guestHome = await worker.fetch(new Request("https://world.example/session", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-session",
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({ cityId: "nashville", spaceId: `home-${FRIEND_ID}` }),
    }), env);
    assert.equal(guestHome.status, 403);

    const wrongSpace = await worker.fetch(new Request(
      `https://world.example/world/nashville/art-yard?ticket=${encodeURIComponent(ticket)}`,
      { headers: { Origin: ORIGIN, Upgrade: "websocket" } },
    ), env);
    assert.equal(wrongSpace.status, 401);
    assert.equal((await wrongSpace.json()).error, "The world ticket does not match this space.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private Block Home tickets require a permanent, social-ready visitor with database access", async () => {
  const env = environment();
  let homeAccess = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: USER_ID, is_anonymous: false });
    }
    if (url.includes("/rest/v1/profiles")) {
      return Response.json([{
        terms_accepted_at: "2026-07-29T12:00:00Z",
        age_confirmed_at: "2026-07-29T12:00:00Z",
        terms_version: "2026-07",
      }]);
    }
    if (url.includes("/rest/v1/user_blocks")) return Response.json([]);
    if (url.endsWith("/rest/v1/rpc/can_visit_home")) return Response.json(homeAccess);
    throw new Error(`Unexpected test request: ${url}`);
  };

  const requestHome = () => worker.fetch(new Request("https://world.example/session", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-session",
      "Content-Type": "application/json",
      Origin: ORIGIN,
    },
    body: JSON.stringify({ cityId: "nashville", spaceId: `home-${FRIEND_ID}` }),
  }), env);

  try {
    const admitted = await requestHome();
    assert.equal(admitted.status, 200);
    assert.equal(typeof (await admitted.json()).ticket, "string");

    homeAccess = false;
    const denied = await requestHome();
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "That Block Home is not open to you.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anonymous guest sessions receive short-lived Circle TURN credentials", async () => {
  const env = {
    ...environment(),
    CLOUDFLARE_TURN_KEY_ID: "turn-key",
    CLOUDFLARE_TURN_API_TOKEN: "turn-token",
  };
  let requestedTtl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: USER_ID, is_anonymous: true });
    }
    if (url.includes("rtc.live.cloudflare.com")) {
      requestedTtl = JSON.parse(String(init?.body)).ttl;
      return Response.json({
        iceServers: [{
          urls: ["turn:example.com:3478"],
          username: "guest-turn-user",
          credential: "guest-turn-password",
        }],
      });
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://world.example/ice-servers", {
      headers: {
        Authorization: "Bearer guest-session",
        Origin: ORIGIN,
      },
    }), env);
    assert.equal(response.status, 200);
    assert.equal(requestedTtl, 900);
    const result = await response.json();
    assert.equal(result.relayAvailable, true);
    assert.equal(result.iceServers[0].urls[0], "turn:example.com:3478");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Portal reports per-room population and only the caller's accepted friends", async () => {
  const requestedRoomNames = [];
  const roomStatus = new Map([
    ["nashville:town-square", { onlineCount: 12, friendUserIds: [FRIEND_ID, STRANGER_ID] }],
    ["nashville:film-district", { onlineCount: 4, friendUserIds: [] }],
    ["nashville:art-yard", { onlineCount: 7, friendUserIds: [FRIEND_ID] }],
    ["nashville:night-market", { onlineCount: 2, friendUserIds: [] }],
  ]);
  const env = {
    ...environment(),
    TOWN_SQUARE: {
      idFromName(name) {
        requestedRoomNames.push(name);
        return name;
      },
      get(id) {
        return {
          async fetch(request) {
            const { friendUserIds } = await request.json();
            const status = roomStatus.get(id);
            return Response.json({
              onlineCount: status?.onlineCount ?? 0,
              friendUserIds: (status?.friendUserIds ?? []).filter(userId => friendUserIds.includes(userId)),
            });
          },
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: USER_ID, is_anonymous: false });
    }
    if (url.includes("/rest/v1/neighbors")) {
      return Response.json([
        {
          user_id: USER_ID,
          neighbor_id: FRIEND_ID,
        },
      ]);
    }
    throw new Error(`Unexpected test request: ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://world.example/portal", {
      headers: {
        Authorization: "Bearer test-session",
        Origin: ORIGIN,
      },
    }), env);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(requestedRoomNames, [
      "nashville:town-square",
      "nashville:film-district",
      "nashville:art-yard",
      "nashville:night-market",
    ]);
    assert.deepEqual(snapshot.rooms.map(room => room.onlineCount), [12, 4, 7, 2]);
    assert.deepEqual(snapshot.rooms.flatMap(room => room.friendUserIds), [FRIEND_ID, FRIEND_ID]);
    assert.equal(snapshot.rooms.flatMap(room => room.friendUserIds).includes(STRANGER_ID), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
