import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";

// TEMPORARY PRE-ALPHA TEST HARNESS.
// Remove this function, its client routing, and its workflow deployment before alpha.
interface TesterDefinition {
  id: string;
  emailHash: string;
  displayName: string;
  handle: string;
  blockColor: string;
  homeName: string;
}

const TESTERS: readonly TesterDefinition[] = [
  {
    id: "974a8b3e-810c-4e33-a117-2912734fc937",
    emailHash: "a912b075dc5d6ee1d4b18555b6f945b4ce385685a2d618df777b1cd9cc69550c",
    displayName: "Tester One",
    handle: "tester_one",
    blockColor: "#ff6b6b",
    homeName: "Tester One's Block",
  },
  {
    id: "cb02fbb1-8aa6-4633-b7ef-63da33b9b416",
    emailHash: "4d6354517290bc3abad094924bdacdbd70ea884a899aec3c3a837cba4b9a6bec",
    displayName: "Tester Two",
    handle: "tester_two",
    blockColor: "#4dabf7",
    homeName: "Tester Two's Block",
  },
] as const;

const ALLOWED_ORIGINS = new Set([
  "https://vfxblender.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";
  const cors = corsHeaders(origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin is not allowed." }, 403, cors);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, cors);

  try {
    const input = await request.json().catch(() => null);
    const email = normalizeEmail(
      typeof input === "object" && input !== null && "email" in input
        ? String(input.email)
        : "",
    );
    if (!email || email.length > 254) return json({ tester: false }, 200, cors);

    const emailHash = await sha256(email);
    const tester = TESTERS.find(candidate => candidate.emailHash === emailHash);
    if (!tester) return json({ tester: false }, 200, cors);

    const supabaseUrl = requiredEnvironment("SUPABASE_URL");
    const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
    const publicKey = requiredEnvironment("SUPABASE_ANON_KEY");
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const password = await testerPassword(serviceRoleKey, tester.id);

    await ensureTesterAccount(admin, tester, email, password);
    await connectTesterAccounts(admin);

    const auth = createClient(supabaseUrl, publicKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw error ?? new Error("Tester session was not created.");

    return json({
      tester: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    }, 200, cors);
  } catch (error) {
    console.error("Tester login failed", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Tester sign-in is temporarily unavailable." }, 500, cors);
  }
});

async function ensureTesterAccount(
  admin: SupabaseClient,
  tester: TesterDefinition,
  email: string,
  password: string,
): Promise<void> {
  const existing = await admin.auth.admin.getUserById(tester.id);
  if (existing.error && existing.error.status !== 404) throw existing.error;

  if (existing.data.user) {
    const { error } = await admin.auth.admin.updateUserById(tester.id, {
      email,
      password,
      email_confirm: true,
      app_metadata: {
        ...existing.data.user.app_metadata,
        blockaroo_tester: true,
      },
    });
    if (error) throw error;
  } else {
    const { error } = await admin.auth.admin.createUser({
      id: tester.id,
      email,
      password,
      email_confirm: true,
      app_metadata: { blockaroo_tester: true },
    });
    if (error) throw error;
  }

  const now = new Date().toISOString();
  const profile = await admin.from("profiles").upsert({
    user_id: tester.id,
    display_name: tester.displayName,
    handle: tester.handle,
    block_color: tester.blockColor,
    home_city_id: "nashville",
    bio: "Private Blockaroo tester account.",
    interests: ["testing"],
    last_seen_at: now,
    terms_accepted_at: now,
    age_confirmed_at: now,
    terms_version: "2026-07",
  }, { onConflict: "user_id" });
  if (profile.error) throw profile.error;

  const home = await admin.from("homes").upsert({
    owner_id: tester.id,
    city_id: "nashville",
    name: tester.homeName,
    access_mode: "open",
    welcome_note: "A persistent home for testing Neighborhood visits and chat.",
  }, { onConflict: "owner_id" });
  if (home.error) throw home.error;
}

async function connectTesterAccounts(admin: SupabaseClient): Promise<void> {
  const [first, second] = TESTERS;
  const [firstUser, secondUser] = await Promise.all([
    admin.auth.admin.getUserById(first.id),
    admin.auth.admin.getUserById(second.id),
  ]);
  if (!firstUser.data.user || !secondUser.data.user) return;

  const resets = await Promise.all([
    admin.from("user_blocks").delete().eq("blocker_id", first.id).eq("blocked_id", second.id),
    admin.from("user_blocks").delete().eq("blocker_id", second.id).eq("blocked_id", first.id),
    admin.from("neighbors").delete().eq("user_id", second.id).eq("neighbor_id", first.id),
  ]);
  const resetError = resets.find(result => result.error)?.error;
  if (resetError) throw resetError;

  const friendship = await admin.from("neighbors").upsert({
    user_id: first.id,
    neighbor_id: second.id,
    status: "accepted",
  }, { onConflict: "user_id,neighbor_id" });
  if (friendship.error) throw friendship.error;
}

async function testerPassword(serviceRoleKey: string, testerId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(serviceRoleKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`blockaroo-tester:${testerId}`),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `B1!${encoded}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function corsHeaders(origin: string): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
