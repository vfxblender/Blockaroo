import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNeighborhoodThreads,
  messagesWithFriend,
  recentHouseBlocks,
} from "../src/social/neighborhood.ts";

const CURRENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const MAYA_ID = "22222222-2222-4222-8222-222222222222";
const ANDRE_ID = "33333333-3333-4333-8333-333333333333";

function friend(userId, displayName, since) {
  return {
    userId,
    displayName,
    handle: displayName.toLowerCase(),
    blockColor: "#ff6b6b",
    avatarMode: "color",
    profilePhotoPath: null,
    lastSeenAt: null,
    status: "accepted",
    direction: "outgoing",
    since,
  };
}

function message(id, senderId, recipientId, createdAt, readAt = null) {
  return {
    id,
    senderId,
    recipientId,
    body: id,
    ciphertext: null,
    encryptionVersion: null,
    clientNonce: `44444444-4444-4444-8444-${id.padStart(12, "0")}`,
    createdAt,
    readAt,
  };
}

test("Neighborhood threads contain only the selected friendship and remain chronological", () => {
  const unrelated = message("9", MAYA_ID, ANDRE_ID, "2026-07-29T12:02:00Z");
  const newest = message("3", MAYA_ID, CURRENT_USER_ID, "2026-07-29T12:03:00Z");
  const oldest = message("1", CURRENT_USER_ID, MAYA_ID, "2026-07-29T12:01:00Z");
  assert.deepEqual(
    messagesWithFriend([unrelated, newest, oldest], CURRENT_USER_ID, MAYA_ID).map(item => item.id),
    ["1", "3"],
  );
});

test("the street sorts active conversations first and counts unread incoming messages", () => {
  const friends = [
    friend(MAYA_ID, "Maya", "2026-07-01T12:00:00Z"),
    friend(ANDRE_ID, "Andre", "2026-07-02T12:00:00Z"),
  ];
  const messages = [
    message("1", MAYA_ID, CURRENT_USER_ID, "2026-07-29T12:00:00Z"),
    message("2", CURRENT_USER_ID, MAYA_ID, "2026-07-29T12:01:00Z", "2026-07-29T12:02:00Z"),
    message("3", ANDRE_ID, CURRENT_USER_ID, "2026-07-29T13:00:00Z"),
  ];
  const threads = buildNeighborhoodThreads(friends, messages, CURRENT_USER_ID);
  assert.deepEqual(threads.map(thread => thread.friend.userId), [ANDRE_ID, MAYA_ID]);
  assert.equal(threads[0].unreadCount, 1);
  assert.equal(threads[1].unreadCount, 1);
  assert.equal(threads[0].lastMessage?.id, "3");
});

test("a friendship house shows only its latest ten private message blocks", () => {
  const messages = Array.from({ length: 14 }, (_, index) => (
    message(String(index + 1), CURRENT_USER_ID, MAYA_ID, `2026-07-29T12:${String(index).padStart(2, "0")}:00Z`)
  ));
  assert.deepEqual(recentHouseBlocks(messages).map(item => item.id), ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
});
