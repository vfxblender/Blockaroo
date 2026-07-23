import { createClient, type Session } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    })
  : null;

let sessionPromise: Promise<Session> | null = null;

export async function getOrCreateAnonymousSession(): Promise<Session> {
  sessionPromise ??= createOrReuseSession();
  const pending = sessionPromise;
  try {
    return await pending;
  } finally {
    if (sessionPromise === pending) sessionPromise = null;
  }
}

async function createOrReuseSession(): Promise<Session> {
  if (!supabase) throw new Error("Supabase environment variables are missing.");
  const existing = await supabase.auth.getSession();
  if (existing.error) throw existing.error;
  if (existing.data.session) return existing.data.session;

  const anonymous = await supabase.auth.signInAnonymously();
  if (anonymous.error) throw anonymous.error;
  if (!anonymous.data.session) throw new Error("Anonymous authentication did not return a session.");
  return anonymous.data.session;
}

export function clearCachedSession(): void {
  sessionPromise = null;
}
