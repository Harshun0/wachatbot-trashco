/**
 * BullMQ workers for webhook processing and outbound message sending.
 *
 * Run this file as a separate process:
 *   npm run worker
 *
 * The workers are idempotent:
 *  - Webhook worker: uses providerEventId to skip already-processed events
 *  - Send worker: checks message status before sending; marks DEAD after max retries
 */
import { Worker, UnrecoverableError } from "bullmq";
import { redis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/providers";
import type { WebhookJobData, SendMessageJobData } from "./index";
import type { OutboundContent, TemplateContent, InteractiveContent } from "@/providers/types";

const WEBHOOK_QUEUE = "whatsapp-webhooks";
const SEND_QUEUE = "whatsapp-send";

// ─── Webhook worker ───────────────────────────────────────────────────────────

export const webhookWorker = new Worker<WebhookJobData>(
  WEBHOOK_QUEUE,
  async (job) => {
    const { webhookEventId, rawPayload } = job.data;

    // Check if already processed (idempotency)
    const event = await prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
    });
    if (!event) {
      console.warn(`[WebhookWorker] Event ${webhookEventId} not found, skipping`);
      return;
    }
    if (event.processed) {
      console.info(`[WebhookWorker] Event ${webhookEventId} already processed, skipping`);
      return;
    }

    const provider = getProvider();
    let parsedEvents;
    try {
      parsedEvents = await provider.parseWebhook(rawPayload);
    } catch (err) {
      console.error("[WebhookWorker] Failed to parse webhook payload:", err);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processingError: String(err), processed: true, processedAt: new Date() },
      });
      return; // Non-retryable parse error
    }

    for (const parsed of parsedEvents) {
      if (parsed.kind === "message") {
        await processInboundMessage(parsed, event.organizationId);
      } else {
        await processStatusUpdate(parsed);
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processed: true, processedAt: new Date() },
    });
  },
  {
    connection: redis,
    concurrency: 5,
  }
);

webhookWorker.on("failed", (job, err) => {
  console.error(`[WebhookWorker] Job ${job?.id} failed:`, err.message);
});

// ─── Inbound message processing ───────────────────────────────────────────────

async function processInboundMessage(
  parsed: Extract<import("@/providers/types").ParsedWebhookEvent, { kind: "message" }>,
  organizationId: string | null
) {
  // Resolve organization — fall back to first org if we have no org on the event
  let orgId = organizationId;
  if (!orgId) {
    const firstOrg = await prisma.organization.findFirst({ select: { id: true } });
    orgId = firstOrg?.id ?? null;
  }
  if (!orgId) {
    console.warn("[WebhookWorker] No organization found, skipping inbound message");
    return;
  }

  // Resolve or create contact
  let contact = await prisma.contact.findUnique({
    where: { organizationId_waPhone: { organizationId: orgId, waPhone: parsed.fromPhone } },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        waPhone: parsed.fromPhone,
        optInSource: "INBOUND_MESSAGE",
        optInScope: "all",
      },
    });
  }

  // Resolve or create conversation
  let conversation = await prisma.conversation.findUnique({
    where: { organizationId_contactId: { organizationId: orgId, contactId: contact.id } },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        waPhone: parsed.fromPhone,
        lastInboundAt: parsed.timestamp,
      },
    });
  } else {
    // Update service window
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: parsed.timestamp, status: "OPEN" },
    });
  }

  // Save message (idempotent via providerId unique constraint)
  const existing = await prisma.message.findUnique({ where: { providerId: parsed.providerId } });
  if (existing) {
    console.info(`[WebhookWorker] Message ${parsed.providerId} already saved, skipping`);
    return;
  }

  await prisma.message.create({
    data: {
      organizationId: orgId,
      conversationId: conversation.id,
      providerId: parsed.providerId,
      direction: "INBOUND",
      contentType: contentTypeToEnum(parsed.contentType),
      content: parsed.content as object,
      status: "DELIVERED", // Inbound = delivered to us
    },
  });
}

// ─── Status update processing ─────────────────────────────────────────────────

async function processStatusUpdate(
  parsed: Extract<import("@/providers/types").ParsedWebhookEvent, { kind: "status" }>
) {
  const message = await prisma.message.findUnique({ where: { providerId: parsed.providerId } });
  if (!message) {
    console.warn(`[WebhookWorker] Status update for unknown message ${parsed.providerId}, skipping`);
    return;
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
      updates.failureReason = parsed.errorTitle ?? parsed.errorCode ?? "Provider reported failure";
      break;
  }

  await prisma.message.update({ where: { id: message.id }, data: updates });
}

// ─── Send worker ──────────────────────────────────────────────────────────────

const MAX_SEND_ATTEMPTS = 3;

export const sendWorker = new Worker<SendMessageJobData>(
  SEND_QUEUE,
  async (job) => {
    const { messageId, to, contentType, content } = job.data;

    // Fetch message, check it's still in a sendable state
    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new UnrecoverableError(`Message ${messageId} not found`);
    }
    if (message.status === "SENT" || message.status === "DELIVERED" || message.status === "READ") {
      console.info(`[SendWorker] Message ${messageId} already sent, skipping`);
      return;
    }
    if (message.status === "DEAD") {
      throw new UnrecoverableError(`Message ${messageId} is in dead-letter state`);
    }

    const provider = getProvider();
    let result;

    try {
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
      const isLast = (job.attemptsMade + 1) >= MAX_SEND_ATTEMPTS;

      if (isLast) {
        // Mark dead-letter
        await prisma.message.update({
          where: { id: messageId },
          data: {
            status: "DEAD",
            failedAt: new Date(),
            failureReason: String(err),
            retryCount: job.attemptsMade + 1,
          },
        });
        throw new UnrecoverableError(`Message ${messageId} exhausted retries: ${String(err)}`);
      }

      await prisma.message.update({
        where: { id: messageId },
        data: { retryCount: job.attemptsMade + 1, failureReason: String(err) },
      });
      throw err; // Let BullMQ retry
    }
  },
  {
    connection: redis,
    concurrency: 10,
  }
);

sendWorker.on("failed", (job, err) => {
  console.error(`[SendWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
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

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.info("Shutting down workers...");
  await Promise.all([webhookWorker.close(), sendWorker.close()]);
  await redis.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.info("✅ WhatsApp workers started");
