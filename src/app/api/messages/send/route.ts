/**
 * POST /api/messages/send
 *
 * Enqueues an outbound message for delivery with bounded retries.
 * Returns the DB message id immediately; actual sending happens in the worker.
 *
 * Auth: requires `x-internal-api-key` header matching INTERNAL_API_KEY env var.
 * This is a service-to-service endpoint — it should never be called directly
 * from a browser client.
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
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendQueue } from "@/queues";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function checkApiKey(request: NextRequest): boolean {
  const provided = request.headers.get("x-internal-api-key") ?? "";
  const expected = env.INTERNAL_API_KEY;
  // timingSafeEqual prevents timing attacks; requires equal-length buffers
  try {
    return timingSafeEqual(
      Buffer.from(provided.padEnd(expected.length)),
      Buffer.from(expected)
    ) && provided.length === expected.length;
  } catch {
    return false;
  }
}

// ─── Request validation ───────────────────────────────────────────────────────

const sendSchema = z.object({
  organizationId: z.string().min(1),
  conversationId: z.string().min(1),
  contentType: z.enum(["text", "template", "interactive"]),
  content: z.record(z.string(), z.unknown()),
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  if (!checkApiKey(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // Verify conversation belongs to this organization (org-scoping)
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
