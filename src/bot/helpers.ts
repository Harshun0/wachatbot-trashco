/**
 * Bot helper utilities.
 *
 * enqueueReply — creates a Message row (PENDING) and adds it to the send queue.
 * This is the ONLY way the bot should send messages — never call the provider
 * directly — so all outbound messages are idempotent and retry-safe.
 *
 * dedupeKey — derive a stable BullMQ jobId from the inbound message id + step,
 * so a duplicate inbound webhook never sends a second reply.
 */
import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import type { OutboundContent } from "@/providers/types";

export interface ReplyOptions {
  organizationId: string;
  conversationId: string;
  to: string;                // E.164 recipient
  content: OutboundContent;
  /** Stable key — same key = BullMQ deduplicates, no second send */
  dedupeKey: string;
}

/**
 * Persist a PENDING message and enqueue it for sending.
 * Idempotent: if a job with the same dedupeKey already exists in the queue,
 * BullMQ ignores the add (jobId uniqueness).
 */
export async function enqueueReply(opts: ReplyOptions): Promise<void> {
  const { organizationId, conversationId, to, content, dedupeKey } = opts;

  const contentType = content.type as "text" | "template" | "interactive";

  const message = await prisma.message.create({
    data: {
      organizationId,
      conversationId,
      direction: "OUTBOUND",
      contentType: contentType.toUpperCase() as
        | "TEXT"
        | "TEMPLATE"
        | "INTERACTIVE",
      content: content as object,
      status: "PENDING",
    },
  });

  await sendQueue.add(
    "send-message",
    {
      messageId: message.id,
      organizationId,
      conversationId,
      to,
      contentType,
      content,
    },
    { jobId: `send_${dedupeKey}` }
  );
}

/**
 * Build an InteractiveContent with up to 3 reply buttons.
 * Button titles are capped at 20 chars (WhatsApp limit).
 */
export function buildButtons(
  body: string,
  buttons: Array<{ id: string; title: string }>,
  footer?: string
): OutboundContent {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply" as const,
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
}

/**
 * Build a simple text reply.
 */
export function buildText(body: string): OutboundContent {
  return { type: "text", body };
}

/**
 * Returns true if conversation's lastInboundAt is within the 24-hour window.
 * Only interactive / text messages are allowed inside the window.
 */
export function isWithin24h(lastInboundAt: Date | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - lastInboundAt.getTime() <= 24 * 60 * 60 * 1000;
}
