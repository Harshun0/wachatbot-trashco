/**
 * Integration-style tests for processInboundMessage and processStatusUpdate.
 *
 * These call the real worker functions (not handleOnboarding directly), so they
 * exercise the full path: contact upsert → conversation upsert → message save
 * → bot dispatch. Prisma and sendQueue are mocked.
 *
 * Tests:
 *  1. New contact → Party created + reply enqueued  (was failing before bug fix)
 *  2. Duplicate inbound (P2002) → bot STILL runs, same jobId (dedupe)
 *  3. processStatusUpdate attempt < 3 → throws (BullMQ retries)
 *  4. processStatusUpdate attempt >= 3 → logs warning, does NOT throw
 *  5. processStatusUpdate message found → updates status in DB
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InternalInboundMessage, InternalStatusUpdate } from "@/providers/types";

// ─── Mocks (must use vi.fn() inline — no outer variable references) ───────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organization: { findFirst: vi.fn() },
    contact: { create: vi.fn(), findUniqueOrThrow: vi.fn() },
    conversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    message: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    party: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    webhookEvent: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/queues", () => ({
  sendQueue: { add: vi.fn() },
  webhookQueue: { add: vi.fn() },
  sweeperQueue: { add: vi.fn(), upsertJobScheduler: vi.fn() },
}));

// Workers import Redis at module load — stub it out
vi.mock("@/lib/redis", () => ({
  redis: { on: vi.fn(), quit: vi.fn() },
}));

// Provider not needed for these tests
vi.mock("@/providers", () => ({
  getProvider: vi.fn(),
  resetProvider: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import { processInboundMessage, processStatusUpdate } from "@/queues/worker";

// ─── Typed mock accessors ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<any>>;

const org    = prisma.organization as unknown as { findFirst: MockFn };
const cont   = prisma.contact      as unknown as { create: MockFn; findUniqueOrThrow: MockFn };
const conv   = prisma.conversation as unknown as {
  findUnique: MockFn; create: MockFn; update: MockFn; findUniqueOrThrow: MockFn;
};
const msg    = prisma.message      as unknown as { create: MockFn; findUnique: MockFn; update: MockFn };
const pty    = prisma.party        as unknown as { findUnique: MockFn; create: MockFn; update: MockFn };
const qadd   = sendQueue.add       as MockFn;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID  = "org_main";
const WAMID   = "wamid_live_001";
const FROM    = "+919900000001";

function makeInbound(msgId = WAMID): InternalInboundMessage {
  return {
    kind: "message",
    providerEventId: `msg_${msgId}`,
    providerId: msgId,
    fromPhone: FROM,
    toPhone: "+919900000000",
    timestamp: new Date(),
    contentType: "text",
    content: { body: "Hii" },
  };
}

function makeStatus(providerId = WAMID, status: InternalStatusUpdate["status"] = "delivered"): InternalStatusUpdate {
  return {
    kind: "status",
    providerEventId: `status_${providerId}_${status}`,
    providerId,
    status,
    timestamp: new Date(),
    recipientPhone: FROM,
  };
}

const CONTACT_ROW  = { id: "contact_1", waPhone: FROM, organizationId: ORG_ID };
const CONV_ROW     = { id: "conv_1",    contactId: "contact_1", organizationId: ORG_ID, lastInboundAt: new Date() };
const MESSAGE_ROW  = { id: "msg_1",     providerId: WAMID };
const PARTY_NEW    = { id: "party_1",   contactId: "contact_1", organizationId: ORG_ID, onboardingStep: "ASK_ROLE" };

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path setup
  org.findFirst.mockResolvedValue({ id: ORG_ID });
  cont.create.mockResolvedValue(CONTACT_ROW);
  cont.findUniqueOrThrow.mockResolvedValue(CONTACT_ROW);
  conv.findUnique.mockResolvedValue(null); // new conversation
  conv.create.mockResolvedValue(CONV_ROW);
  conv.update.mockResolvedValue({ ...CONV_ROW, lastInboundAt: new Date() });
  conv.findUniqueOrThrow.mockResolvedValue({ ...CONV_ROW, lastInboundAt: new Date() });
  msg.create.mockResolvedValue(MESSAGE_ROW);
  msg.findUnique.mockResolvedValue(null);
  msg.update.mockResolvedValue({});

  // Party not yet created (new contact)
  pty.findUnique.mockResolvedValue(null);
  pty.create.mockResolvedValue(PARTY_NEW);
  pty.update.mockResolvedValue({ ...PARTY_NEW, onboardingStep: "ASK_NAME" });

  // enqueueReply inside bot creates a message row
  msg.create
    .mockResolvedValueOnce(MESSAGE_ROW)         // inbound message save
    .mockResolvedValue({ id: "msg_reply_1" });  // bot reply message

  qadd.mockResolvedValue(undefined);
});

// ─── 1. New contact: Party created + reply enqueued ───────────────────────────

describe("processInboundMessage — new contact", () => {
  it("creates Party and enqueues ASK_ROLE reply (the bug this fix targets)", async () => {
    await processInboundMessage(makeInbound(), ORG_ID);

    // Party must be created
    expect(pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "ASK_ROLE" }),
      })
    );

    // A reply must be enqueued
    expect(qadd).toHaveBeenCalledWith(
      "send-message",
      expect.anything(),
      expect.objectContaining({
        jobId: expect.stringContaining(`onboard_role_${WAMID}`),
      })
    );
  });

  it("saves the inbound message to DB", async () => {
    await processInboundMessage(makeInbound(), ORG_ID);

    expect(msg.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: "INBOUND", status: "DELIVERED" }),
      })
    );
  });

  it("falls back to findFirst org when organizationId is null", async () => {
    await processInboundMessage(makeInbound(), null);

    expect(org.findFirst).toHaveBeenCalled();
    expect(pty.create).toHaveBeenCalled();
  });
});

// ─── 2. Duplicate inbound (P2002 on message.create) ──────────────────────────

describe("processInboundMessage — duplicate inbound (P2002)", () => {
  it("bot STILL runs even when message row already exists", async () => {
    // First call: message.create succeeds
    // Second call: message.create throws P2002
    const p2002 = Object.assign(new Error("unique constraint"), { code: "P2002" });
    msg.create
      .mockResolvedValueOnce(MESSAGE_ROW)        // inbound save — first call
      .mockRejectedValueOnce(p2002)              // inbound save — second call (duplicate)
      .mockResolvedValue({ id: "msg_reply_1" }); // bot reply saves

    // First delivery
    await processInboundMessage(makeInbound(WAMID), ORG_ID);
    const firstCallCount = qadd.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second delivery of same wamid — resets party.findUnique for second run
    pty.findUnique.mockResolvedValue(PARTY_NEW);
    pty.update.mockResolvedValue({ ...PARTY_NEW, onboardingStep: "ASK_NAME" });

    await processInboundMessage(makeInbound(WAMID), ORG_ID);

    // Bot ran again — queue was called again
    expect(qadd.mock.calls.length).toBeGreaterThan(firstCallCount);

    // Both calls produced the same jobId prefix → BullMQ deduplicates
    const jobIds = qadd.mock.calls
      .map((c: unknown[]) => (c[2] as { jobId?: string })?.jobId ?? "")
      .filter((id: string) => id.includes(`onboard_role_${WAMID}`));
    expect(new Set(jobIds).size).toBe(1);
  });
});

// ─── 3 & 4. processStatusUpdate — attempt cap ────────────────────────────────

describe("processStatusUpdate — unknown message", () => {
  it("throws when attemptsMade < 3 (triggers BullMQ retry)", async () => {
    msg.findUnique.mockResolvedValue(null);

    await expect(processStatusUpdate(makeStatus(), 0)).rejects.toThrow();
    await expect(processStatusUpdate(makeStatus(), 1)).rejects.toThrow();
    await expect(processStatusUpdate(makeStatus(), 2)).rejects.toThrow();
  });

  it("does NOT throw when attemptsMade >= 3 (gives up gracefully)", async () => {
    msg.findUnique.mockResolvedValue(null);

    await expect(processStatusUpdate(makeStatus(), 3)).resolves.toBeUndefined();
    await expect(processStatusUpdate(makeStatus(), 5)).resolves.toBeUndefined();
  });
});

// ─── 5. processStatusUpdate — message found ──────────────────────────────────

describe("processStatusUpdate — message found", () => {
  const MESSAGE_DB_ROW = { id: "msg_db_1", providerId: WAMID };

  it("updates status to DELIVERED", async () => {
    msg.findUnique.mockResolvedValue(MESSAGE_DB_ROW);

    await processStatusUpdate(makeStatus(WAMID, "delivered"), 0);

    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MESSAGE_DB_ROW.id },
        data: expect.objectContaining({ status: "DELIVERED" }),
      })
    );
  });

  it("updates status to READ", async () => {
    msg.findUnique.mockResolvedValue(MESSAGE_DB_ROW);

    await processStatusUpdate(makeStatus(WAMID, "read"), 0);

    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "READ" }),
      })
    );
  });

  it("updates status to FAILED with reason", async () => {
    msg.findUnique.mockResolvedValue(MESSAGE_DB_ROW);
    const failedStatus: InternalStatusUpdate = {
      ...makeStatus(WAMID, "failed"),
      errorCode: "131047",
      errorTitle: "Re-engagement message",
    };

    await processStatusUpdate(failedStatus, 0);

    expect(msg.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          failureReason: "Re-engagement message",
        }),
      })
    );
  });
});
