/**
 * BullMQ queue definitions.
 * Import queues here; workers run in src/queues/worker.ts.
 */
import { Queue } from "bullmq";
import { redis } from "@/lib/redis";

// ─── Webhook processing queue ─────────────────────────────────────────────────

export interface WebhookJobData {
  webhookEventId: string; // DB id of the WebhookEvent row
  rawPayload: string;
  provider: string;
}

export const webhookQueue = new Queue<WebhookJobData>("whatsapp-webhooks", {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

// ─── Outbound message queue ───────────────────────────────────────────────────

export interface SendMessageJobData {
  messageId: string;     // DB id of the Message row
  organizationId: string;
  conversationId: string;
  to: string;            // recipient E.164 phone
  contentType: "text" | "template" | "interactive";
  content: unknown;      // serialised OutboundContent
}

export const sendQueue = new Queue<SendMessageJobData>("whatsapp-send", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});
