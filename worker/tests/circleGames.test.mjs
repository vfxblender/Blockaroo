import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCircleGameAction,
  circleGameSnapshot,
  createCircleGame,
  validateGamePlayers,
} from "../src/circleGames.ts";

const players = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

test("game player limits enforce the launch rules", () => {
  assert.equal(validateGamePlayers("cards", 1), "At least two Circle members are needed.");
  assert.equal(validateGamePlayers("bluff", 3), "Bluff needs at least four players.");
  assert.equal(validateGamePlayers("bluff", 4), null);
});

test("Crazy Blocks keeps hands private and advances turns", () => {
  const state = createCircleGame("cards", players);
  const first = circleGameSnapshot(state, players[0]);
  assert.equal(first.game, "cards");
  assert.equal(first.privateState.hand.length, 5);
  assert.equal("hands" in first.publicState, false);
  assert.equal(first.publicState.currentPlayerId, players[0]);

  assert.equal(applyCircleGameAction(state, players[0], players[0], "draw", undefined), null);
  const next = circleGameSnapshot(state, players[1]);
  assert.equal(next.publicState.currentPlayerId, players[1]);
  assert.equal(next.privateState.hand.length, 5);
});

test("Draw & Guess reveals the word only to the artist", () => {
  const state = createCircleGame("draw", players);
  const artist = circleGameSnapshot(state, players[0]);
  const guesser = circleGameSnapshot(state, players[1]);
  assert.equal(artist.privateState.isArtist, true);
  assert.equal(typeof artist.privateState.word, "string");
  assert.equal(guesser.privateState.word, undefined);
  assert.equal(applyCircleGameAction(state, players[0], players[0], "stroke", {
    x1: 0.1,
    y1: 0.1,
    x2: 0.2,
    y2: 0.2,
    color: "#14213d",
    width: 5,
  }), null);
  const delta = circleGameSnapshot(state, players[1], true);
  assert.equal(delta.publicState.strokeDelta, true);
  assert.equal(delta.publicState.strokes.length, 1);

  const word = artist.privateState.word;
  assert.equal(applyCircleGameAction(state, players[1], players[0], "guess", { guess: word }), null);
  const rotated = circleGameSnapshot(state, players[1]);
  assert.equal(rotated.publicState.artistId, players[1]);
  assert.equal(rotated.publicState.scores[players[1]], 2);
});

test("Bluff assigns one private impostor and resolves a full vote", () => {
  const state = createCircleGame("bluff", players);
  const snapshots = players.map(player => circleGameSnapshot(state, player));
  const impostorIndex = snapshots.findIndex(snapshot => snapshot.privateState.role === "impostor");
  assert.notEqual(impostorIndex, -1);
  const impostorId = players[impostorIndex];
  for (const player of players) {
    const targetId = player === impostorId ? players.find(candidate => candidate !== player) : impostorId;
    assert.equal(applyCircleGameAction(state, player, players[0], "vote", { targetId }), null);
  }
  const result = circleGameSnapshot(state, players[0]);
  assert.equal(result.phase, "result");
  assert.equal(result.publicState.winners, "crew");
  assert.equal(result.publicState.revealedImpostorId, impostorId);
});

test("Square-Off accepts authoritative movement and host restarts", () => {
  const state = createCircleGame("square-off", players);
  const before = circleGameSnapshot(state, players[0]);
  const start = before.publicState.positions[players[0]];
  const length = Math.hypot(start.x, start.y);
  for (let move = 0; move < 12; move += 1) {
    applyCircleGameAction(state, players[0], players[0], "move", {
      dx: start.x / length,
      dy: start.y / length,
    });
  }
  const after = circleGameSnapshot(state, players[0]);
  assert.equal(after.publicState.positions[players[0]].eliminated, true);
  assert.equal(applyCircleGameAction(state, players[0], players[0], "restart", undefined), null);
  const restarted = circleGameSnapshot(state, players[0]);
  assert.equal(restarted.phase, "playing");
  assert.equal(restarted.publicState.round, 2);
});
