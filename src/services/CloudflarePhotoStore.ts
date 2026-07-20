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

  async download(mediaId: string, downloadToken: string): Promise<string> {
    const response = await fetch(this.downloadUrl(mediaId, downloadToken), {
      cache: "no-store",
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(result?.error || "Cloudflare could not download the temporary picture.");
    }

    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
    const declaredLength = Number(response.headers.get("Content-Length") || 0);
    if (contentType !== "image/jpeg"
      || (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES)) {
      throw new Error("Cloudflare returned an invalid temporary picture.");
    }

    const blob = await response.blob();
    if (blob.size <= 3 || blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("Cloudflare returned an invalid-sized temporary picture.");
    }
    return blobToDataUrl(blob);
  }

  private downloadUrl(mediaId: string, downloadToken: string): string {
    const url = new URL(this.mediaUrl(mediaId));
    url.searchParams.set("token", downloadToken);
    return url.toString();
  }

  private mediaUrl(mediaId: string): string {
    return `${this.endpoint.replace(/\/$/, "")}/media/${encodeURIComponent(mediaId)}`;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/jpeg;base64,")) {
        resolve(reader.result);
      } else {
        reject(new Error("The temporary picture could not be decoded."));
      }
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("The temporary picture could not be decoded.")), { once: true });
    reader.readAsDataURL(blob);
  });
}
