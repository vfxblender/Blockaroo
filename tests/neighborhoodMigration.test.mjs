import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260730053707_neighborhood_portal_messaging.sql",
  import.meta.url,
);

test("direct messages are persistent, RLS-protected, and ready for future ciphertext", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table public\.direct_messages/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /participants can read their direct messages/i);
  assert.match(sql, /friends can send direct messages/i);
  assert.match(sql, /recipient_id = \(select auth\.uid\(\)\)/i);
  assert.match(sql, /public\.is_social_ready_user\(\)/i);
  assert.match(sql, /public\.has_block_between\(sender_id, recipient_id\)/i);
  assert.match(sql, /ciphertext text/i);
  assert.match(sql, /encryption_version smallint/i);
  assert.doesNotMatch(
    sql.slice(
      sql.indexOf("create table public.direct_messages"),
      sql.indexOf("create index direct_messages_sender_thread_index"),
    ),
    /expires_at/i,
  );
});

test("message access is explicitly granted and Realtime is both published and private", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /revoke all on table public\.direct_messages from public, anon, authenticated/i);
  assert.match(sql, /grant select on table public\.direct_messages to authenticated/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.direct_messages/i);
  assert.match(sql, /on realtime\.messages for select to authenticated/i);
  assert.match(sql, /direct-messages:' \|\| \(select auth\.uid\(\)\)::text/i);
});
