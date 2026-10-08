/**
 * MetaCloudProvider.downloadMedia — the two-step Graph API media fetch
 * (get media URL, then download the binary with the Bearer token) with a
 * mocked global fetch, since Meta media URLs expire and require auth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetaCloudProvider } from "@/providers/meta";
import { ProviderError } from "@/providers/types";

const CFG = {
  phoneNumberId: "919900000000",
  accessToken: "test_token",
  appSecret: "test_secret",
  verifyToken: "test_verify",
};

describe("MetaCloudProvider.downloadMedia", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches the media URL with the Bearer token, then downloads the binary", async () => {
    const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "https://lookaside.fbsbx.com/media/signed-url", mime_type: "image/jpeg" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("binary-image-data").buffer,
      });

    const provider = new MetaCloudProvider(CFG);
    const result = await provider.downloadMedia("wamedia_123");

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/wamedia_123"),
      expect.objectContaining({ headers: { Authorization: "Bearer test_token" } })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://lookaside.fbsbx.com/media/signed-url",
      expect.objectContaining({ headers: { Authorization: "Bearer test_token" } })
    );
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.buffer.toString()).toBe("binary-image-data");
  });

  it("throws a retryable ProviderError when the media URL lookup fails", async () => {
    const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const provider = new MetaCloudProvider(CFG);

    await expect(provider.downloadMedia("expired_media")).rejects.toThrow(ProviderError);
  });

  it("throws a retryable ProviderError when the signed download URL fails", async () => {
    const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "https://lookaside.fbsbx.com/media/expired", mime_type: "image/jpeg" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 410 });

    const provider = new MetaCloudProvider(CFG);

    await expect(provider.downloadMedia("wamedia_456")).rejects.toThrow(ProviderError);
  });
});
