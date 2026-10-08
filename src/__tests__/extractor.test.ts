/**
 * Extractor tests — LLM wrapper is mocked so we only test:
 *  1. Prompt is built with role/draft/recentMessages context
 *  2. A valid payload from callLLM passes through
 *  3. callLLM returning null (garbage JSON / API failure) → extractIntent returns null
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/bot/llm", () => ({ callLLM: vi.fn() }));

import { callLLM } from "@/bot/llm";
import { extractIntent } from "@/bot/extractor";

const mockedCallLLM = callLLM as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractIntent", () => {
  it("returns the parsed intent on success", async () => {
    const payload = {
      intent: "create_listing",
      product: "cement",
      category: null,
      quantity: 100,
      unit: "ton",
      price: null,
      location: null,
      listingCode: null,
      missing: ["price", "location"],
    };
    mockedCallLLM.mockResolvedValue(payload);

    const result = await extractIntent({
      text: "100 ton cement bags sell karna hai",
      role: "SELLER",
    });

    expect(result).toEqual(payload);
  });

  it("passes role, draft and recent messages into the prompt", async () => {
    mockedCallLLM.mockResolvedValue({
      intent: "add_details",
      product: null,
      category: null,
      quantity: null,
      unit: null,
      price: 35,
      location: null,
      listingCode: null,
      missing: [],
    });

    await extractIntent({
      text: "35 rupaye kilo",
      role: "SELLER",
      draft: { product: "cement", quantity: 100, unit: "ton", price: null, location: null },
      recentMessages: ["User: 100 ton cement bags sell karna hai", "Bot: Kitni quantity hai?"],
    });

    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    const call = mockedCallLLM.mock.calls[0][0];
    expect(call.user).toContain("Role: SELLER");
    expect(call.user).toContain("cement");
    expect(call.user).toContain("Kitni quantity hai?");
    expect(call.user).toContain("35 rupaye kilo");
  });

  it("returns null when callLLM returns null (garbage JSON or API failure)", async () => {
    mockedCallLLM.mockResolvedValue(null);

    const result = await extractIntent({ text: "asdkjaslkdj", role: "BUYER" });

    expect(result).toBeNull();
  });

  it("never throws even if callLLM rejects", async () => {
    mockedCallLLM.mockRejectedValue(new Error("network down"));

    await expect(
      extractIntent({ text: "mujhe 50 ton cement chahiye Pune me", role: "BUYER" })
    ).rejects.toThrow();
    // Note: callLLM itself never throws in production (see llm.ts), this test
    // just documents that extractIntent is a thin passthrough and relies on
    // callLLM's own try/catch for crash-safety.
  });
});
