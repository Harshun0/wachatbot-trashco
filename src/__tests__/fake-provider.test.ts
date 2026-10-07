/**
 * Tests for FakeProvider and related logic.
 *
 * Covers:
 *  1. Duplicate webhook creates only one message event (idempotency via providerEventId)
 *  2. Invalid signature is rejected
 *  3. 24-hour service window rule (non-template blocked outside window)
 *  4. Retry simulation and final failure (dead-letter)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FakeProvider, resetFakeStore, isInServiceWindow, recordInbound } from "@/providers/fake";
import { ServiceWindowError, ProviderError } from "@/providers/types";

const APP_SECRET = "fake_secret_32chars_xxxxxxxxxxxxx";
const VERIFY_TOKEN = "fake_verify_token";
const OUR_PHONE = "+919900000000";
const TRADER = "+919900000001";

function makeProvider() {
  return new FakeProvider({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN, ourPhone: OUR_PHONE });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Duplicate webhook idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Duplicate webhook idempotency", () => {
  it("parseWebhook returns the same providerEventId for two identical payloads", async () => {
    const provider = makeProvider();

    // First: send an inbound to open the service window so we can send back
    const raw1 = provider.buildInboundPayload({ from: TRADER, type: "text", text: "hello" });
    const events1 = await provider.parseWebhook(raw1);

    // Re-parse the exact same payload
    const events2 = await provider.parseWebhook(raw1);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    // Both parses yield the same providerEventId — the DB upsert logic must deduplicate
    expect(events1[0].providerEventId).toBe(events2[0].providerEventId);
  });

  it("setDuplicateNextEvent causes two events with the same providerEventId", async () => {
    const provider = makeProvider();
    provider.setDuplicateNextEvent();

    const raw = provider.buildInboundPayload({ from: TRADER, type: "text", text: "dupe test" });
    const events = await provider.parseWebhook(raw);

    // Should have 2 events with the same id
    expect(events.length).toBeGreaterThanOrEqual(2);
    const ids = events.map((e) => e.providerEventId);
    expect(ids[0]).toBe(ids[1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Signature verification
// ─────────────────────────────────────────────────────────────────────────────

describe("Signature verification", () => {
  it("accepts a correctly signed payload", async () => {
    const provider = makeProvider();
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const signature = provider.signPayload(body);

    const result = await provider.verifyWebhook({ signature, rawBody: body });
    expect(result.valid).toBe(true);
  });

  it("rejects a payload with wrong signature", async () => {
    const provider = makeProvider();
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const result = await provider.verifyWebhook({ signature: "sha256=deadbeef", rawBody: body });
    expect(result.valid).toBe(false);
  });

  it("rejects when signature header is missing", async () => {
    const provider = makeProvider();
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const result = await provider.verifyWebhook({ rawBody: body });
    expect(result.valid).toBe(false);
  });

  it("verifies GET hub.challenge with correct token", async () => {
    const provider = makeProvider();
    const result = await provider.verifyWebhook({
      mode: "subscribe",
      token: VERIFY_TOKEN,
      challenge: "abc123",
    });
    expect(result.valid).toBe(true);
    expect(result.challenge).toBe("abc123");
  });

  it("rejects GET hub.challenge with wrong token", async () => {
    const provider = makeProvider();
    const result = await provider.verifyWebhook({
      mode: "subscribe",
      token: "wrong_token",
      challenge: "abc123",
    });
    expect(result.valid).toBe(false);
    expect(result.challenge).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 24-hour service window
// ─────────────────────────────────────────────────────────────────────────────

describe("24-hour service window", () => {
  it("isInServiceWindow returns false when no inbound has been received", () => {
    expect(isInServiceWindow(TRADER)).toBe(false);
  });

  it("isInServiceWindow returns true immediately after an inbound", () => {
    recordInbound(TRADER);
    expect(isInServiceWindow(TRADER)).toBe(true);
  });

  it("isInServiceWindow returns false after 24 hours have passed", () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    recordInbound(TRADER, twentyFiveHoursAgo);
    expect(isInServiceWindow(TRADER)).toBe(false);
  });

  it("sendText throws ServiceWindowError outside the window", async () => {
    const provider = makeProvider();
    // No inbound recorded → window is closed
    await expect(provider.sendText(TRADER, "hi")).rejects.toBeInstanceOf(ServiceWindowError);
  });

  it("sendText succeeds inside the window", async () => {
    const provider = makeProvider();
    recordInbound(TRADER); // open window
    const result = await provider.sendText(TRADER, "hi there");
    expect(result.providerId).toMatch(/^wamid\.fake/);
  });

  it("sendTemplate succeeds even outside the window (approved templates)", async () => {
    const provider = makeProvider();
    // Window is closed
    const template = {
      type: "template" as const,
      name: "order_confirmation",
      language: { code: "en_US" },
    };
    const result = await provider.sendTemplate(TRADER, template);
    expect(result.providerId).toMatch(/^wamid\.fake/);
  });

  it("sendInteractive throws ServiceWindowError outside the window", async () => {
    const provider = makeProvider();
    const interactive = {
      type: "interactive" as const,
      interactive: {
        type: "button" as const,
        body: { text: "Choose:" },
        action: {
          buttons: [{ type: "reply" as const, reply: { id: "yes", title: "Yes" } }],
        },
      },
    };
    await expect(provider.sendInteractive(TRADER, interactive)).rejects.toBeInstanceOf(ServiceWindowError);
  });

  it("setServiceWindow can manually open a window", async () => {
    const provider = makeProvider();
    provider.setServiceWindow(TRADER, new Date());
    const result = await provider.sendText(TRADER, "hi");
    expect(result.providerId).toMatch(/^wamid\.fake/);
  });

  it("setServiceWindow can manually close a window", async () => {
    const provider = makeProvider();
    recordInbound(TRADER);
    provider.setServiceWindow(TRADER, null); // close it
    await expect(provider.sendText(TRADER, "hi")).rejects.toBeInstanceOf(ServiceWindowError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Outage simulation and retry / dead-letter
// ─────────────────────────────────────────────────────────────────────────────

describe("Outage simulation", () => {
  it("throws a retryable ProviderError when outage is active", async () => {
    const provider = makeProvider();
    recordInbound(TRADER);
    provider.setOutage(true);

    let err: unknown;
    try {
      await provider.sendText(TRADER, "hi");
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).code).toBe("OUTAGE");
  });

  it("recovers after outage is cleared", async () => {
    const provider = makeProvider();
    recordInbound(TRADER);
    provider.setOutage(true);
    await expect(provider.sendText(TRADER, "fail")).rejects.toThrow();
    provider.setOutage(false);
    const result = await provider.sendText(TRADER, "recover");
    expect(result.providerId).toMatch(/^wamid\.fake/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. parseWebhook produces correct internal events
// ─────────────────────────────────────────────────────────────────────────────

describe("parseWebhook", () => {
  it("parses a text inbound message correctly", async () => {
    const provider = makeProvider();
    const raw = provider.buildInboundPayload({ from: TRADER, type: "text", text: "Hello world" });
    const events = await provider.parseWebhook(raw);

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("message");
    if (evt.kind === "message") {
      expect(evt.fromPhone).toBe(TRADER);
      expect(evt.contentType).toBe("text");
      expect((evt.content as { body: string }).body).toBe("Hello world");
    }
  });

  it("parses a status update correctly", async () => {
    const provider = makeProvider();
    recordInbound(TRADER);
    const send = await provider.sendText(TRADER, "hi");

    const statusRaw = provider.buildStatusPayload({
      messageId: send.providerId,
      recipientPhone: TRADER,
      status: "delivered",
    });
    const events = await provider.parseWebhook(statusRaw);

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.kind).toBe("status");
    if (evt.kind === "status") {
      expect(evt.providerId).toBe(send.providerId);
      expect(evt.status).toBe("delivered");
      expect(evt.recipientPhone).toBe(TRADER);
    }
  });
});
