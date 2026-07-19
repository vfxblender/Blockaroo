import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = { "Content-Type": "application/json" };

Deno.serve(async request => {
  const cleanupSecret = Deno.env.get("CLEANUP_SECRET");
  if (!cleanupSecret || request.headers.get("X-Cleanup-Secret") !== cleanupSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Function environment is incomplete" }), { status: 500, headers });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: expired, error: selectError } = await supabase
    .from("temporary_media")
    .select("id, object_path")
    .lt("expires_at", new Date().toISOString())
    .limit(200);
  if (selectError) return new Response(JSON.stringify({ error: selectError.message }), { status: 500, headers });
  if (!expired?.length) return new Response(JSON.stringify({ removed: 0 }), { status: 200, headers });

  const paths = expired.map(item => item.object_path);
  const { error: storageError } = await supabase.storage.from("temporary-block-posts").remove(paths);
  if (storageError) return new Response(JSON.stringify({ error: storageError.message }), { status: 500, headers });

  const { error: deleteError } = await supabase
    .from("temporary_media")
    .delete()
    .in("id", expired.map(item => item.id));
  if (deleteError) return new Response(JSON.stringify({ error: deleteError.message }), { status: 500, headers });
  return new Response(JSON.stringify({ removed: expired.length }), { status: 200, headers });
});
