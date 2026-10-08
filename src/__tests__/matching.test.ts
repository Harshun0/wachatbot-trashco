/**
 * Phase 3 matching engine tests.
 *
 * Covers:
 *  1. matchCriteria — product/quantity/price/location rules
 *  2. runMatchingForListing — creates Match + notifies buyer (interactive, in-window)
 *  3. Notification outside 24h window → falls back to template (when configured)
 *  4. Notification outside window with no template configured → skipped, no crash
 *  5. alertPreference NONE → no notification sent
 *  6. Contact opted out → no notification sent
 *  7. Alert cap reached → no notification sent
 *  8. Idempotency — existing Match with notifiedBuyerAt set is not re-notified
 *  9. Buyer "Interested" → seller gets contact details, buyer gets confirmation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    requirement: { findMany: vi.fn() },
    listing: { findMany: vi.fn() },
    match: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    party: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    message: { create: vi.fn() },
  },
}));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

vi.mock("@/bot/rate-limit", () => ({ allowAlert: vi.fn().mockResolvedValue(true), allowLLMCall: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import {
  matchCriteria,
  runMatchingForListing,
  handleBuyerInterested,
} from "@/bot/matching";
import { allowAlert } from "@/bot/rate-limit";
import type { Listing, Requirement } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<any>>;

const requirement = prisma.requirement as unknown as { findMany: MockFn };
const match = prisma.match as unknown as { findUnique: MockFn; create: MockFn; update: MockFn };
const party = prisma.party as unknown as { findUnique: MockFn };
const conversation = prisma.conversation as unknown as { findUnique: MockFn };
const message = prisma.message as unknown as { create: MockFn };
const queueAdd = sendQueue.add as MockFn;
const mockedAllowAlert = allowAlert as unknown as MockFn;

const ORG = "org_main";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseListing(overrides: Record<string, any> = {}): Listing {
  return {
    id: "listing_1",
    organizationId: ORG,
    sellerPartyId: "seller_party_1",
    code: "LST-0001",
    product: "cement",
    category: null,
    quantity: 100,
    unit: "ton",
    pricePerUnit: 35,
    currency: "INR",
    location: "Mumbai",
    description: null,
    status: "OPEN",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Listing;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseRequirement(overrides: Record<string, any> = {}): Requirement {
  return {
    id: "req_1",
    organizationId: ORG,
    buyerPartyId: "buyer_party_1",
    product: "cement",
    category: null,
    quantity: 50,
    unit: "ton",
    maxPrice: 40,
    location: "Mumbai",
    status: "OPEN",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Requirement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAllowAlert.mockResolvedValue(true);
  message.create.mockResolvedValue({ id: "msg_out" });
  queueAdd.mockResolvedValue(undefined);
});

// ─── 1. matchCriteria ──────────────────────────────────────────────────────────

describe("matchCriteria", () => {
  it("matches when product/quantity/price/location all satisfy the requirement", () => {
    expect(matchCriteria(baseListing(), baseRequirement())).toBe(true);
  });

  it("rejects different products", () => {
    expect(matchCriteria(baseListing({ product: "steel" }), baseRequirement())).toBe(false);
  });

  it("rejects when listing quantity is less than requirement quantity", () => {
    expect(matchCriteria(baseListing({ quantity: 10 }), baseRequirement({ quantity: 50 }))).toBe(false);
  });

  it("rejects when listing price exceeds requirement maxPrice", () => {
    expect(matchCriteria(baseListing({ pricePerUnit: 50 }), baseRequirement({ maxPrice: 40 }))).toBe(false);
  });

  it("rejects when locations don't overlap", () => {
    expect(matchCriteria(baseListing({ location: "Delhi" }), baseRequirement({ location: "Mumbai" }))).toBe(false);
  });

  it("ignores location when the buyer didn't specify one", () => {
    expect(matchCriteria(baseListing({ location: "Delhi" }), baseRequirement({ location: null }))).toBe(true);
  });

  it("doesn't block on missing listing fields the buyer didn't require", () => {
    expect(
      matchCriteria(baseListing({ quantity: null, pricePerUnit: null }), baseRequirement({ quantity: null, maxPrice: null }))
    ).toBe(true);
  });
});

// ─── 2. runMatchingForListing — creates Match + notifies ─────────────────────

describe("runMatchingForListing", () => {
  it("creates a Match and notifies the buyer in-window with an Interested button", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_1", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000001" } });
    conversation.findUnique.mockResolvedValue({ id: "conv_1", lastInboundAt: new Date() });

    await runMatchingForListing(ORG, baseListing());

    expect(match.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ listingId: "listing_1", requirementId: "req_1" }) })
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({
        content: expect.objectContaining({
          interactive: expect.objectContaining({
            action: expect.objectContaining({
              buttons: expect.arrayContaining([
                expect.objectContaining({ reply: expect.objectContaining({ title: "Interested" }) }),
              ]),
            }),
          }),
        }),
      }),
      expect.anything()
    );
    expect(match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notifiedBuyerAt: expect.any(Date) }) })
    );
  });

  it("outside the 24h window with a template configured → sends a template message", async () => {
    process.env.WA_TEMPLATE_MATCH_BUYER = "match_alert_buyer";
    vi.resetModules();
    const { runMatchingForListing: run } = await import("@/bot/matching");

    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_2", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000001" } });
    conversation.findUnique.mockResolvedValue({ id: "conv_1", lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    await run(ORG, baseListing());

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ type: "template", name: "match_alert_buyer" }) }),
      expect.anything()
    );

    delete process.env.WA_TEMPLATE_MATCH_BUYER;
  });

  it("outside the window with no template configured → skips, never crashes", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_3", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000001" } });
    conversation.findUnique.mockResolvedValue({ id: "conv_1", lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    await expect(runMatchingForListing(ORG, baseListing())).resolves.toBeUndefined();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("alertPreference NONE → no notification sent", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_4", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "NONE", contact: { optedOut: false, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "NONE", contact: { optedOut: false, waPhone: "+919900000001" } });

    await runMatchingForListing(ORG, baseListing());

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("opted-out contact → no notification sent", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_5", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "ALL", contact: { optedOut: true, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "ALL", contact: { optedOut: true, waPhone: "+919900000001" } });

    await runMatchingForListing(ORG, baseListing());

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("alert cap reached → no notification sent", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue(null);
    match.create.mockResolvedValue({ id: "match_6", notifiedBuyerAt: null, notifiedSellerAt: null });
    party.findUnique
      .mockResolvedValueOnce({ id: "buyer_party_1", contactId: "buyer_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000002" } })
      .mockResolvedValueOnce({ id: "seller_party_1", contactId: "seller_contact", alertPreference: "ALL", contact: { optedOut: false, waPhone: "+919900000001" } });
    mockedAllowAlert.mockResolvedValue(false);

    await runMatchingForListing(ORG, baseListing());

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("already-notified Match (notifiedBuyerAt set) → doesn't re-notify", async () => {
    requirement.findMany.mockResolvedValue([baseRequirement()]);
    match.findUnique.mockResolvedValue({
      id: "match_7",
      notifiedBuyerAt: new Date(),
      notifiedSellerAt: new Date(),
    });

    await runMatchingForListing(ORG, baseListing());

    expect(match.create).not.toHaveBeenCalled();
    expect(party.findUnique).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

// ─── 9. Buyer "Interested" ─────────────────────────────────────────────────────

describe("handleBuyerInterested", () => {
  it("notifies the seller with buyer contact details and confirms to the buyer", async () => {
    (prisma.match as unknown as { findUnique: MockFn }).findUnique.mockResolvedValue({
      id: "match_1",
      listing: {
        code: "LST-0001",
        sellerParty: { contactId: "seller_contact", contact: { waPhone: "+919900000001" } },
      },
      requirement: {
        buyerParty: {
          name: "Rahul",
          city: "Pune",
          contactId: "buyer_contact",
          contact: { waPhone: "+919900000002" },
        },
      },
    });
    (prisma.match as unknown as { update: MockFn }).update.mockResolvedValue({});
    conversation.findUnique
      .mockResolvedValueOnce({ id: "conv_seller" })
      .mockResolvedValueOnce({ id: "conv_buyer" });

    await handleBuyerInterested(ORG, "match_1", "wamid_interested_1");

    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("919900000002") }) }),
      expect.anything()
    );
    expect(queueAdd).toHaveBeenCalledWith(
      "send-message",
      expect.objectContaining({ content: expect.objectContaining({ body: expect.stringContaining("Seller ko bata") }) }),
      expect.anything()
    );
  });
});
