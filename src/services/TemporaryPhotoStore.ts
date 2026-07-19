import { supabase } from "./supabase";

const bucket = (import.meta.env.VITE_TEMPORARY_MEDIA_BUCKET as string | undefined) || "temporary-block-posts";
const DELETE_AFTER_MS = 60_000;
const DATABASE_EXPIRY_MS = 120_000;
const SIGNED_URL_SECONDS = 30;

export class TemporaryPhotoStore {
  async upload(authUserId: string, imageDataUrl: string): Promise<string> {
    if (!supabase) throw new Error("Supabase is not configured for temporary pictures.");
    if (!imageDataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("Only prepared JPEG pictures can be uploaded.");

    const response = await fetch(imageDataUrl);
    const blob = await response.blob();
    const objectPath = `${authUserId}/${Date.now()}-${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage.from(bucket).upload(objectPath, blob, {
      contentType: "image/jpeg",
      cacheControl: "30",
      upsert: false,
    });
    if (error) throw error;
    const { error: registryError } = await supabase.from("temporary_media").insert({
      owner_id: authUserId,
      object_path: objectPath,
      expires_at: new Date(Date.now() + DATABASE_EXPIRY_MS).toISOString(),
    });
    if (registryError) {
      await supabase.storage.from(bucket).remove([objectPath]);
      throw registryError;
    }
    return objectPath;
  }

  async createSignedUrl(objectPath: string): Promise<string> {
    if (!supabase) throw new Error("Supabase is not configured for temporary pictures.");
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, SIGNED_URL_SECONDS);
    if (error) throw error;
    return data.signedUrl;
  }

  scheduleRemoval(objectPath: string): void {
    const client = supabase;
    if (!client) return;
    window.setTimeout(() => {
      void client.storage.from(bucket).remove([objectPath]).then(async ({ error }) => {
        if (error) console.warn("Blockaroo temporary picture cleanup will be retried by the server job", error.message);
        if (!error) await client.from("temporary_media").delete().eq("object_path", objectPath);
      });
    }, DELETE_AFTER_MS);
  }
}
