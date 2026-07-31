import assert from "node:assert/strict";
import test from "node:test";
import {
  HOME_FURNITURE_KINDS,
  createHomeFurniture,
  defaultHomeInterior,
  normalizeHomeInterior,
} from "../src/social/homeInterior.ts";

test("the furnished default contains every supported Block Home item", () => {
  const layout = defaultHomeInterior("#12abef");
  assert.equal(layout.version, 1);
  assert.equal(layout.furniture.find(item => item.kind === "sofa")?.color, "#12abef");
  assert.deepEqual(
    new Set(layout.furniture.map(item => item.kind)),
    new Set(HOME_FURNITURE_KINDS),
  );
});

test("normalization preserves rugs and coffee tables while rejecting unknown furniture", () => {
  const normalized = normalizeHomeInterior({
    version: 1,
    wallColor: "#ABCDEF",
    floorColor: "#123456",
    lighting: "night",
    furniture: [
      { id: "rug-custom", kind: "rug", x: -100, y: 400, rotation: 14, color: "#FF00AA" },
      { id: "table-custom", kind: "coffee-table", x: 52, y: 71, rotation: 90, color: "#9a6b42" },
      { id: "bad", kind: "spaceship", x: 50, y: 50, rotation: 0, color: "#ffffff" },
    ],
  });
  assert.deepEqual(normalized.furniture.map(item => item.kind), ["rug", "coffee-table"]);
  assert.equal(normalized.wallColor, "#abcdef");
  assert.equal(normalized.lighting, "night");
  assert.equal(normalized.furniture[0]?.x, 5);
  assert.equal(normalized.furniture[0]?.y, 90);
  assert.equal(normalized.furniture[0]?.rotation, 0);
});

test("an intentionally empty room remains empty and new furniture has safe defaults", () => {
  const empty = normalizeHomeInterior({
    version: 1,
    wallColor: "#f3dfbd",
    floorColor: "#d2aa78",
    lighting: "day",
    furniture: [],
  });
  assert.deepEqual(empty.furniture, []);

  const television = createHomeFurniture("tv", 1);
  assert.equal(television.kind, "tv");
  assert.equal(television.y, 43);
  assert.match(television.id, /^tv-/);
});

test("a hostile layout cannot exceed the room limit or reuse item identities", () => {
  const furniture = Array.from({ length: 30 }, (_, index) => ({
    id: "same-id",
    kind: index % 2 ? "rug" : "coffee-table",
    x: 50,
    y: 70,
    rotation: 0,
    color: "#123456",
  }));
  const normalized = normalizeHomeInterior({
    version: 1,
    wallColor: "#f3dfbd",
    floorColor: "#d2aa78",
    lighting: "warm",
    furniture,
  });
  assert.equal(normalized.furniture.length, 24);
  assert.equal(new Set(normalized.furniture.map(item => item.id)).size, 24);
});
