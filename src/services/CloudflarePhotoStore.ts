import type { PhotoGrantMessage } from "../../shared/worldProtocol";

const MAX_UPLOAD_BYTES = 110 * 1024;

export class CloudflarePhotoStore {
  constructor(private readonly endpoint: string) {}

  async upload(grant: PhotoGrantMessage, imageDataUrl: string): Promise<void> {
    if (!imageDataUrl.startsWith("data:image/jpeg;base64,")) {
      throw new Error("Only prepared JPEG pictures can be uploaded.");
    }
    if (grant.expiresAt <= Date.now()) throw new Error("The temporary photo upload grant expired.");

    const blob = await (await fetch(imageDataUrl)).blob();
    if (blob.size <= 0 || blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("The prepared picture is larger than the temporary-photo limit.");
    }

    const response = await fetch(this.mediaUrl(grant.mediaId), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${grant.uploadToken}`,
        "Content-Type": "image/jpeg",
      },
      body: blob,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(result?.error || "Cloudflare rejected the temporary picture upload.");
    }
  }

  downloadUrl(mediaId: string, downloadToken: string): string {
    const url = new URL(this.mediaUrl(mediaId));
    url.searchParams.set("token", downloadToken);
    return url.toString();
  }

  private mediaUrl(mediaId: string): string {
    return `${this.endpoint.replace(/\/$/, "")}/media/${encodeURIComponent(mediaId)}`;
  }
}
