import { getOrCreateAnonymousSession } from "./supabase";

const MAX_SOCIAL_IMAGE_BYTES = 512 * 1024;
const MAX_SOCIAL_GIF_BYTES = 1024 * 1024;

export class SocialMediaStore {
  constructor(private readonly endpoint: string) {}

  get available(): boolean {
    return Boolean(this.endpoint.trim());
  }

  async upload(postId: string, blob: Blob): Promise<void> {
    if (!this.available) throw new Error("Social pictures need the Cloudflare world server.");
    const maxBytes = blob.type === "image/gif" ? MAX_SOCIAL_GIF_BYTES : MAX_SOCIAL_IMAGE_BYTES;
    if (!["image/jpeg", "image/gif"].includes(blob.type) || blob.size <= 3 || blob.size > maxBytes) {
      throw new Error("The prepared social picture is invalid.");
    }
    const token = (await getOrCreateAnonymousSession()).access_token;
    const response = await fetch(this.postUrl(postId), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": blob.type,
      },
      body: blob,
    });
    if (!response.ok) throw await responseError(response, "The social picture upload failed.");
  }

  async download(postId: string): Promise<string> {
    if (!this.available) throw new Error("Social pictures need the Cloudflare world server.");
    const token = (await getOrCreateAnonymousSession()).access_token;
    const response = await fetch(this.postUrl(postId), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response, "The social picture could not be opened.");
    const blob = await response.blob();
    const contentType = blob.type.split(";", 1)[0];
    const maxBytes = contentType === "image/gif" ? MAX_SOCIAL_GIF_BYTES : MAX_SOCIAL_IMAGE_BYTES;
    if (!["image/jpeg", "image/gif"].includes(contentType) || blob.size <= 3 || blob.size > maxBytes) {
      throw new Error("The social picture response was invalid.");
    }
    return URL.createObjectURL(blob);
  }

  async remove(postId: string): Promise<void> {
    if (!this.available) return;
    const token = (await getOrCreateAnonymousSession()).access_token;
    const response = await fetch(this.postUrl(postId), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      throw await responseError(response, "The social picture could not be removed.");
    }
  }

  async deleteAccount(): Promise<void> {
    if (!this.available) throw new Error("Account deletion needs the Cloudflare world server so private media can be removed first.");
    const token = (await getOrCreateAnonymousSession()).access_token;
    const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/account`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    if (!response.ok) throw await responseError(response, "The account could not be deleted.");
  }

  private postUrl(postId: string): string {
    return `${this.endpoint.replace(/\/$/, "")}/social-media/${encodeURIComponent(postId)}`;
  }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const result = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(result?.error || fallback);
}
