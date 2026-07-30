import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_PORTAL_ROOMS,
  homeOwnerFromSpaceId,
  homeSpaceId,
  isPortalRoomId,
  isWorldSpaceId,
} from "../shared/portalRooms.ts";

const OWNER_ID = "22222222-2222-4222-8222-222222222222";

test("Portal launches with Town Square, two permanent rooms, and one rotating event", () => {
  assert.deepEqual(
    PUBLIC_PORTAL_ROOMS.map(room => room.id),
    ["town-square", "film-district", "art-yard", "night-market"],
  );
  assert.equal(PUBLIC_PORTAL_ROOMS.filter(room => room.event).length, 1);
  assert.equal(PUBLIC_PORTAL_ROOMS[0].id, "town-square");
});

test("private home addresses round-trip while arbitrary world spaces are rejected", () => {
  const spaceId = homeSpaceId(OWNER_ID);
  assert.equal(spaceId, `home-${OWNER_ID}`);
  assert.equal(homeOwnerFromSpaceId(spaceId), OWNER_ID);
  assert.equal(isWorldSpaceId(spaceId), true);
  assert.equal(isPortalRoomId(spaceId), false);
  assert.equal(isWorldSpaceId("made-up-room"), false);
  assert.equal(homeSpaceId("not-a-user-id"), null);
});
