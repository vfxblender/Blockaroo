import assert from "node:assert/strict";
import test from "node:test";
import { CircleCoordinator } from "../src/circles.ts";

const HOST = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

class MemoryStorage {
  values = new Map();
  alarm = null;

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of list) {
      if (this.values.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async setAlarm(time) {
    this.alarm = time;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

class FakeState {
  storage = new MemoryStorage();
  ready = Promise.resolve();

  blockConcurrencyWhile(callback) {
    this.ready = callback();
  }
}

function fixture() {
  const state = new FakeState();
  const participants = new Map([
    [HOST, { userId: HOST, playerId: HOST, username: "Host", color: "#ff6b6b", socialReady: true }],
    [GUEST, { userId: GUEST, playerId: GUEST, username: "Guest", color: "#4ecdc4", socialReady: true }],
    [THIRD, { userId: THIRD, playerId: THIRD, username: "Third", color: "#ffd166", socialReady: true }],
  ]);
  const positions = new Map([
    [HOST, { x: 100, y: 100 }],
    [GUEST, { x: 180, y: 100 }],
    [THIRD, { x: 900, y: 900 }],
  ]);
  const messages = [];
  const blocked = new Set();
  const coordinator = new CircleCoordinator(state, {
    participant: userId => participants.get(userId) ?? null,
    networkPlayer: userId => {
      const person = participants.get(userId);
      const position = positions.get(userId);
      if (!person || !position) return null;
      return {
        id: userId,
        authUserId: userId,
        slot: 1,
        username: person.username,
        color: person.color,
        x: position.x,
        y: position.y,
        velocityX: 0,
        velocityY: 0,
        sequence: 0,
        updatedAt: Date.now(),
        zone: 1,
      };
    },
    send: (userId, message) => messages.push({ userId, message }),
    publishPresence: () => undefined,
    blockedBetween: (first, second) => blocked.has([first, second].sort().join(":")),
  });
  return { state, participants, positions, messages, blocked, coordinator };
}

function latest(messages, userId, type) {
  return messages.findLast(entry => entry.userId === userId && entry.message.type === type)?.message;
}

async function createCircle(context) {
  await context.state.ready;
  await context.coordinator.handle(context.participants.get(HOST), {
    type: "circle-invite",
    targetPlayerId: GUEST,
    mode: "request",
  });
  const invitation = latest(context.messages, GUEST, "circle-invite");
  assert.ok(invitation);
  await context.coordinator.handle(context.participants.get(GUEST), {
    type: "circle-invite-response",
    invitationId: invitation.invitationId,
    accept: true,
  });
  return latest(context.messages, HOST, "circle-state").circle;
}

test("Circle membership is proximity-bound and blocked pairs cannot connect", async () => {
  const context = fixture();
  await context.state.ready;
  context.blocked.add([HOST, GUEST].sort().join(":"));
  await context.coordinator.handle(context.participants.get(HOST), {
    type: "circle-invite",
    targetPlayerId: GUEST,
    mode: "request",
  });
  assert.equal(latest(context.messages, HOST, "error").code, "circle_blocked");

  context.blocked.clear();
  const circle = await createCircle(context);
  await context.coordinator.handle(context.participants.get(THIRD), {
    type: "circle-join-request",
    circleId: circle.id,
  });
  assert.equal(latest(context.messages, THIRD, "error").code, "circle_too_far");
});

test("host can start and end a private game", async () => {
  const context = fixture();
  await createCircle(context);
  await context.coordinator.handle(context.participants.get(HOST), {
    type: "circle-game-start",
    game: "cards",
  });
  assert.equal(latest(context.messages, HOST, "circle-game-state").snapshot.game, "cards");
  assert.equal(latest(context.messages, HOST, "circle-state").circle.game, "cards");

  await context.coordinator.handle(context.participants.get(GUEST), { type: "circle-game-end" });
  assert.equal(latest(context.messages, GUEST, "error").code, "circle_host_only");

  await context.coordinator.handle(context.participants.get(HOST), { type: "circle-game-end" });
  assert.equal(latest(context.messages, HOST, "circle-state").circle.game, null);
});

test("drawing history is persisted outside the shared Circle record", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const context = fixture();
    await createCircle(context);
    await context.coordinator.handle(context.participants.get(HOST), {
      type: "circle-game-start",
      game: "draw",
    });
    for (let index = 0; index < 12; index += 1) {
      now += 25;
      await context.coordinator.handle(context.participants.get(HOST), {
        type: "circle-game-action",
        action: "stroke",
        payload: {
          x1: index / 20,
          y1: 0.1,
          x2: (index + 1) / 20,
          y2: 0.2,
          color: "#14213d",
          width: 5,
        },
      });
    }
    now += 125;
    await context.coordinator.handle(context.participants.get(GUEST), {
      type: "circle-game-action",
      action: "guess",
      payload: { guess: "definitely-not-the-word" },
    });

    const storedCircles = context.state.storage.values.get("social-circles");
    assert.equal(storedCircles[0].gameState.strokes.length, 0);
    const drawing = [...context.state.storage.values.entries()]
      .find(([key]) => key.startsWith("social-circle-drawing:"))?.[1];
    assert.equal(drawing.length, 12);
  } finally {
    Date.now = originalNow;
  }
});

test("active games lock Circle membership until the round ends", async () => {
  const context = fixture();
  const circle = await createCircle(context);
  context.positions.set(THIRD, { x: 140, y: 100 });

  await context.coordinator.handle(context.participants.get(HOST), {
    type: "circle-game-start",
    game: "cards",
  });
  await context.coordinator.handle(context.participants.get(THIRD), {
    type: "circle-join-request",
    circleId: circle.id,
  });
  assert.equal(latest(context.messages, THIRD, "error").code, "circle_game_locked");
  assert.equal(latest(context.messages, HOST, "circle-state").circle.members.length, 2);

  await context.coordinator.handle(context.participants.get(HOST), { type: "circle-game-end" });
  await context.coordinator.handle(context.participants.get(THIRD), {
    type: "circle-join-request",
    circleId: circle.id,
  });
  assert.equal(latest(context.messages, HOST, "circle-join-request").requester.id, THIRD);
});

test("an unclean disconnect keeps Circle membership during the reconnect grace", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const context = fixture();
    await createCircle(context);
    await context.coordinator.removeParticipant(GUEST, true);
    assert.equal(context.state.storage.alarm, now + 15_000);

    now += 10_000;
    await context.coordinator.restoreParticipant(GUEST);
    now += 10_000;
    await context.coordinator.alarm();

    const circle = latest(context.messages, HOST, "circle-state").circle;
    assert.equal(circle.members.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("a disconnected Circle member leaves after the reconnect grace", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const context = fixture();
    await createCircle(context);
    context.participants.delete(GUEST);
    await context.coordinator.removeParticipant(GUEST, true);

    now += 15_001;
    await context.coordinator.alarm();

    const circle = latest(context.messages, HOST, "circle-state").circle;
    assert.equal(circle.members.length, 1);
    assert.equal(context.state.storage.alarm, now + 10_000);
  } finally {
    Date.now = originalNow;
  }
});

test("walking beyond the grace radius leaves and the lone Circle closes after ten seconds", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const context = fixture();
    const circle = await createCircle(context);
    await context.coordinator.checkPosition(GUEST, 1_000, 1_000);
    assert.equal(latest(context.messages, GUEST, "circle-closed").reason, "You walked away from the Circle.");
    assert.equal(latest(context.messages, HOST, "circle-state").circle.members.length, 1);
    assert.equal(context.state.storage.alarm, now + 10_000);

    now += 10_001;
    await context.coordinator.alarm();
    const closed = latest(context.messages, HOST, "circle-closed");
    assert.equal(closed.circleId, circle.id);
    assert.match(closed.reason, /empty Circle closed/i);
  } finally {
    Date.now = originalNow;
  }
});
