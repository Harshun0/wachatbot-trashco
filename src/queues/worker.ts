/**
 * BullMQ workers — run as a separate process:  npm run worker
 *
 * Workers:
 *  1. webhookWorker  — processes inbound webhook_events from the DB
 *  2. sendWorker     — sends outbound messages via the WhatsApp provider
 *  3. sweeperWorker  — rescues webhook_events that were persisted but never
 *                      enqueued (e.g. Redis was down when the webhook arrived)
 */
import { Worker, UnrecoverableError } from "bullmq";
import { redis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/providers";
import { ProviderError } from "@/providers/types";
import type { WebhookJobData, SendMessageJobData, SweeperJobData } from "./index";
import type { TemplateContent, InteractiveContent } from "@/providers/types";

const WEBHOOK_QUEUE = "whatsapp-webhooks";
const SEND_QUEUE    = "whatsapp-send";
const SWEEPER_QUEUE = "whatsapp-sweeper";

// ─── 1. Webhook worker ────────────────────────────────────────────────────────

export const webhookWorker = new Worker<WebhookJobData>(
  WEBHOOK_QUEUE,
  async (job) => {
    const { webhookEventId, rawPayload } = job.data;

    // Idempotency check
    const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!event) {
      // Row gone — nothing to process, treat as done
      console.warn(`[WebhookWorker] Event ${webhookEventId} not found in DB, skipping`);
      return;
    }
    if (event.processed) {
      console.info(`[WebhookWorker] Event ${webhookEventId} already processed`);
      return;
    }

    const provider = getProvider();
    let parsedEvents;
    try {
      parsedEvents = await provider.parseWebhook(rawPayload);
    } catch (err) {
      // Unparseable payload — mark done so we don't retry indefinitely
      console.error("[WebhookWorker] Failed to parse webhook payload:", err);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processingError: String(err), processed: true, processedAt: new Date() },
      });
      return;
    }

    for (const parsed of parsedEvents) {
      if (parsed.kind === "message") {
        await processInboundMessage(parsed, event.organizationId);
      } else {
        // Fix 4: throw so BullMQ retries if the message row doesn't exist yet
        await processStatusUpdate(parsed);
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processed: true, processedAt: new Date() },
    });
  },
  { connection: redis, concurrency: 5 }
);

webhookWorker.on("failed", (job, err) => {
  console.error(`[WebhookWorker] Job ${job?.id} failed:`, err.message);
});

// ─── Inbound message processing ───────────────────────────────────────────────

async function processInboundMessage(
  parsed: Extract<import("@/providers/types").ParsedWebhookEvent, { kind: "message" }>,
  organizationId: string | null
) {
  let orgId = organizationId;
  if (!orgId) {
    const firstOrg = await prisma.organization.findFirst({ select: { id: true } });
    orgId = firstOrg?.id ?? null;
  }
  if (!orgId) {
    console.warn("[WebhookWorker] No organization found, skipping inbound message");
    return;
  }

  // Upsert contact — race-safe: create, catch P2002, then fetch
  let contact = await upsertContact(orgId, parsed.fromPhone);

  // Upsert conversation
  let conversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: contact.id } },
  });
  if (!conversation) {
    try {
      conversation = await prisma.conversation.create({
        data: {
          organizationId: orgId,
          contactId: contact.id,
          waPhone: parsed.fromPhone,
          lastInboundAt: parsed.timestamp,
        },
      });
    } catch (err) {
      if (!isPrismaError(err, "P2002")) throw err;
      // Race: someone else created it — refetch
      conversation = await prisma.conversation.findUniqueOrThrow({
        where: { organizationId_contactId: { organizationId: orgId, contactId: contact.id } },
      });
    }
  }

  // Extend service window
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastInboundAt: parsed.timestamp, status: "OPEN" },
  });

  // Save inbound message — idempotent via providerId unique constraint
  try {
    await prisma.message.create({
      data: {
        organizationId: orgId,
        conversationId: conversation.id,
        providerId: parsed.providerId,
        direction: "INBOUND",
        contentType: contentTypeToEnum(parsed.contentType),
        content: parsed.content as object,
        status: "DELIVERED",
      },
    });
  } catch (err) {
    if (isPrismaError(err, "P2002")) {
      console.info(`[WebhookWorker] Message ${parsed.providerId} already saved`);
      return;
    }
    throw err;
  }
}

async function upsertContact(orgId: string, waPhone: string) {
  try {
    return await prisma.contact.create({
      data: {
        organizationId: orgId,
        waPhone,
        optInSource: "INBOUND_MESSAGE",
        // Fix (baad mein wala): scope = "service" per spec AC14
        // "all" → "service" (transactional only; offers need explicit opt-in)
        optInScope: "service",
      },
    });
  } catch (err) {
    if (!isPrismaError(err, "P2002")) throw err;
    return prisma.contact.findUniqueOrThrow({
      where: { organizationId_waPhone: { organizationId: orgId, waPhone } },
    });
  }
}

// ─── Status update processing ─────────────────────────────────────────────────
// Fix 4: Throw (not return) when the message row isn't found yet.
// This happens when a status webhook arrives before the send-worker has saved
// the providerId. BullMQ will retry with exponential backoff.

async function processStatusUpdate(
  parsed: Extract<import("@/providers/types").ParsedWebhookEvent, { kind: "status" }>
) {
  const message = await prisma.message.findUnique({ where: { providerId: parsed.providerId } });
  if (!message) {
    // Throw — not UnrecoverableError — so BullMQ retries
    throw new Error(
      `[WebhookWorker] Status update for unknown message ${parsed.providerId} — will retry`
    );
  }

  const updates: Record<string, unknown> = {};
  switch (parsed.status) {
    case "sent":
      updates.status = "SENT";
      updates.sentAt = parsed.timestamp;
      break;
    case "delivered":
      updates.status = "DELIVERED";
      updates.deliveredAt = parsed.timestamp;
      break;
    case "read":
      updates.status = "READ";
      updates.readAt = parsed.timestamp;
      break;
    case "failed":
      updates.status = "FAILED";
      updates.failedAt = parsed.timestamp;
      updates.failureReason =
        parsed.errorTitle ?? parsed.errorCode ?? "Provider reported failure";
      break;
  }

  await prisma.message.update({ where: { id: message.id }, data: updates });
}

// ─── 2. Send worker ───────────────────────────────────────────────────────────
// Fix 5: Check ProviderError.retryable — non-retryable errors skip retries and
// go straight to dead-letter state.

const MAX_SEND_ATTEMPTS = 3;

export const sendWorker = new Worker<SendMessageJobData>(
  SEND_QUEUE,
  async (job) => {
    const { messageId, to, contentType, content } = job.data;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new UnrecoverableError(`Message ${messageId} not found`);
    }
    // Already terminal — skip
    if (["SENT", "DELIVERED", "READ"].includes(message.status)) {
      console.info(`[SendWorker] Message ${messageId} already sent`);
      return;
    }
    if (message.status === "DEAD") {
      throw new UnrecoverableError(`Message ${messageId} is already dead-letter`);
    }

    const provider = getProvider();

    try {
      let result;
      switch (contentType) {
        case "text": {
          const c = content as { body: string };
          result = await provider.sendText(to, c.body);
          break;
        }
        case "template":
          result = await provider.sendTemplate(to, content as TemplateContent);
          break;
        case "interactive":
          result = await provider.sendInteractive(to, content as InteractiveContent);
          break;
        default:
          throw new UnrecoverableError(`Unknown content type: ${contentType}`);
      }

      await prisma.message.update({
        where: { id: messageId },
        data: { status: "SENT", providerId: result.providerId, sentAt: new Date() },
      });
    } catch (err) {
      // Fix 5: non-retryable ProviderError → dead-letter immediately
      if (err instanceof ProviderError && !err.retryable) {
        await markDead(messageId, String(err), job.attemptsMade + 1);
        throw new UnrecoverableError(
          `Message ${messageId} non-retryable provider error: ${err.message}`
        );
      }

      const isLastAttempt = job.attemptsMade + 1 >= MAX_SEND_ATTEMPTS;
      if (isLastAttempt) {
        await markDead(messageId, String(err), job.attemptsMade + 1);
        throw new UnrecoverableError(
          `Message ${messageId} exhausted ${MAX_SEND_ATTEMPTS} retries: ${String(err)}`
        );
      }

      // Retryable — update count and let BullMQ retry
      await prisma.message.update({
        where: { id: messageId },
        data: { retryCount: job.attemptsMade + 1, failureReason: String(err) },
      });
      throw err;
    }
  },
  { connection: redis, concurrency: 10 }
);

sendWorker.on("failed", (job, err) => {
  console.error(
    `[SendWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
  );
});

async function markDead(messageId: string, reason: string, retryCount: number) {
  await prisma.message.update({
    where: { id: messageId },
    data: { status: "DEAD", failedAt: new Date(), failureReason: reason, retryCount },
  });
}

// ─── 3. Sweeper worker ────────────────────────────────────────────────────────
// Finds webhook_events that are persisted but not yet processed (processed=false)
// and re-enqueues them. Scheduled by the worker startup below.

export const sweeperWorker = new Worker<SweeperJobData>(
  SWEEPER_QUEUE,
  async () => {
    // Find events stuck in unprocessed state for more than 2 minutes
    const cutoff = new Date(Date.now() - 2 * 60 * 1000);
    const stuck = await prisma.webhookEvent.findMany({
      where: { processed: false, createdAt: { lt: cutoff } },
      take: 50,
      orderBy: { createdAt: "asc" },
    });

    if (stuck.length === 0) return;

    console.info(`[Sweeper] Found ${stuck.length} unprocessed webhook event(s), re-enqueuing`);

    const { webhookQueue } = await import("@/queues");

    for (const event of stuck) {
      await webhookQueue.add(
        "process-webhook",
        {
          webhookEventId: event.id,
          rawPayload: JSON.stringify(event.rawPayload),
          provider: event.provider,
        },
        {
          jobId: `webhook_${event.id}`,
          // addOrIgnore: if the job already exists (was just queued), skip
        }
      );
    }
  },
  { connection: redis, concurrency: 1 }
);

sweeperWorker.on("failed", (job, err) => {
  console.error(`[Sweeper] Job ${job?.id} failed: ${err.message}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ContentTypeEnum =
  | "TEXT" | "TEMPLATE" | "INTERACTIVE" | "IMAGE" | "DOCUMENT"
  | "AUDIO" | "VIDEO" | "STICKER" | "LOCATION" | "CONTACTS" | "REACTION" | "UNKNOWN";

function contentTypeToEnum(type: string): ContentTypeEnum {
  const map: Record<string, ContentTypeEnum> = {
    text: "TEXT", template: "TEMPLATE", interactive: "INTERACTIVE",
    image: "IMAGE", document: "DOCUMENT", audio: "AUDIO", video: "VIDEO",
    sticker: "STICKER", location: "LOCATION", contacts: "CONTACTS",
    reaction: "REACTION",
  };
  return map[type] ?? "UNKNOWN";
}

function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === code
  );
}

// ─── Sweeper schedule: run every 5 minutes ────────────────────────────────────

async function scheduleSweeper() {
  const { sweeperQueue } = await import("@/queues");
  // BullMQ v6+: use upsertJobScheduler for recurring jobs
  await sweeperQueue.upsertJobScheduler(
    "sweeper-recurring",
    { every: 5 * 60 * 1000 }, // every 5 min
    { name: "sweep", data: {} }
  );
  console.info("[Sweeper] Scheduled every 5 minutes");
}

scheduleSweeper().catch((err) => {
  console.error("[Sweeper] Failed to schedule:", err);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.info("Shutting down workers...");
  await Promise.all([
    webhookWorker.close(),
    sendWorker.close(),
    sweeperWorker.close(),
  ]);
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.info("✅ WhatsApp workers started (webhook + send + sweeper)");
