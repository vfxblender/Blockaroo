import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../supabase/migrations/20260730203834_home_interior_layout.sql",
  import.meta.url,
);

test("home interiors are versioned, bounded, and owner-controlled", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /add column if not exists interior_layout jsonb not null/i);
  assert.match(sql, /interior_layout ->> 'version' = '1'/i);
  assert.match(sql, /jsonb_array_length\(interior_layout -> 'furniture'\) <= 24/i);
  assert.match(sql, /pg_column_size\(interior_layout\) <= 16384/i);
  assert.match(sql, /owners and accepted friends can read home profiles/i);
  assert.match(sql, /owner_id = \(select auth\.uid\(\)\)/i);
  assert.doesNotMatch(sql, /for update to anon/i);
});

test("the production migration includes a furnished room and Realtime publication", async () => {
  const sql = await readFile(migration, "utf8");
  for (const kind of ["rug", "sofa", "coffee-table", "armchair", "tv", "floor-lamp", "plant", "bookshelf"]) {
    assert.match(sql, new RegExp(`"kind":"${kind}"`, "i"));
  }
  assert.match(sql, /alter table public\.homes replica identity full/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.homes/i);
});
