/**
 * POST /api/messages/send
 *
 * Enqueues an outbound message for delivery with bounded retries.
 * Returns the DB message id immediately; actual sending happens in the worker.
 *
 * Body schema:
 * {
 *   organizationId: string
 *   conversationId: string
 *   contentType: "text" | "template" | "interactive"
 *   content: OutboundContent
 * }
 */
import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";

export const runtime = "nodejs";

// ─── Request validation ───────────────────────────────────────────────────────

const sendSchema = z.object({
  organizationId: z.string().min(1),
  conversationId: z.string().min(1),
  contentType: z.enum(["text", "template", "interactive"]),
  content: z.record(z.string(), z.unknown()),
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const { organizationId, conversationId, contentType, content } = parsed.data;

  // Verify conversation belongs to this organization
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
    include: { contact: true },
  });

  if (!conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Create message in PENDING state
  const message = await prisma.message.create({
    data: {
      organizationId,
      conversationId,
      direction: "OUTBOUND",
      contentType: contentTypeToEnum(contentType),
      content: content as object,
      status: "PENDING",
    },
  });

  // Enqueue with deduplication via message id
  await sendQueue.add(
    "send-message",
    {
      messageId: message.id,
      organizationId,
      conversationId,
      to: conversation.contact.waPhone,
      contentType,
      content,
    },
    { jobId: `send_${message.id}` }
  );

  return Response.json({ messageId: message.id, status: "queued" }, { status: 202 });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ContentTypeEnum =
  | "TEXT" | "TEMPLATE" | "INTERACTIVE" | "IMAGE" | "DOCUMENT"
  | "AUDIO" | "VIDEO" | "STICKER" | "LOCATION" | "CONTACTS" | "REACTION" | "UNKNOWN";

function contentTypeToEnum(type: string): ContentTypeEnum {
  const map: Record<string, ContentTypeEnum> = {
    text: "TEXT", template: "TEMPLATE", interactive: "INTERACTIVE",
  };
  return map[type] ?? "UNKNOWN";
}
