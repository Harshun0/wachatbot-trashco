/**
 * Media storage abstraction.
 *
 * Current implementation: Cloudinary (signed upload via REST API, no SDK dep).
 * Swap by implementing MediaStorage and changing getStorage().
 *
 * If Cloudinary env vars are not set, getStorage() returns null and callers
 * must fall back to storing the media id only (see bot/listings.ts).
 */
import { createHash } from "crypto";

export interface MediaStorage {
  upload(buffer: Buffer, mimeType: string): Promise<{ url: string }>;
}

class CloudinaryStorage implements MediaStorage {
  constructor(
    private readonly cloudName: string,
    private readonly apiKey: string,
    private readonly apiSecret: string
  ) {}

  async upload(buffer: Buffer, mimeType: string): Promise<{ url: string }> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHash("sha1")
      .update(`timestamp=${timestamp}${this.apiSecret}`)
      .digest("hex");

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }));
    form.append("api_key", this.apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${this.cloudName}/image/upload`,
      { method: "POST", body: form }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudinary upload failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { secure_url: string };
    return { url: data.secure_url };
  }
}

let _storage: MediaStorage | null | undefined;

/** Returns the configured storage backend, or null if not configured. */
export function getStorage(): MediaStorage | null {
  if (_storage !== undefined) return _storage;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  _storage =
    cloudName && apiKey && apiSecret
      ? new CloudinaryStorage(cloudName, apiKey, apiSecret)
      : null;

  return _storage;
}

/** Reset the cached storage backend (useful in tests). */
export function resetStorage(): void {
  _storage = undefined;
}
