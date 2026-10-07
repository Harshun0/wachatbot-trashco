/**
 * Dev-only API for the /dev/whatsapp simulator UI.
 * Blocked in production.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

function isProd() {
  return process.env.NODE_ENV === "production";
}

// ─── GET: state snapshot ──────────────────────────────────────────────────────

export async function GET() {
  if (isProd()) return new Response("Not Found", { status: 404 });

  const { getFakeStore } = await import("@/providers/fake");
  const store = getFakeStore();

  return Response.json({
    sentMessages: store.sentMessages,
    statusEvents: store.statusEvents,
    inboundQueue: store.inboundQueue,
    conversationWindows: Object.fromEntries(store.conversationWindows),
    outageMode: store.outageMode,
  });
}

// ─── POST: simulate events / control ─────────────────────────────────────────

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send_inbound"),
    from: z.string(),
    type: z.enum(["text", "image", "button_reply", "list_reply"]),
    text: z.string().optional(),
    buttonId: z.string().optional(),
    buttonTitle: z.string().optional(),
    listRowId: z.string().optional(),
    listRowTitle: z.string().optional(),
    imageCaption: z.string().optional(),
  }),
  z.object({
    action: z.literal("send_status"),
    messageId: z.string(),
    recipientPhone: z.string(),
    status: z.enum(["delivered", "read", "failed"]),
  }),
  z.object({
    action: z.literal("set_outage"),
    active: z.boolean(),
  }),
  z.object({
    action: z.literal("set_duplicate_next"),
  }),
  z.object({
    action: z.literal("set_service_window"),
    phone: z.string(),
    // null = clear window (simulate expired); ISO string = set timestamp
    timestamp: z.string().nullable(),
  }),
  z.object({
    action: z.literal("reset"),
  }),
]);

export async function POST(request: NextRequest) {
  if (isProd()) return new Response("Not Found", { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 422 });
  }

  const { FakeProvider, resetFakeStore, getFakeStore } = await import("@/providers/fake");
  const { env } = await import("@/lib/env");

  const provider = new FakeProvider({
    verifyToken: env.WA_VERIFY_TOKEN,
    appSecret: env.WA_APP_SECRET,
    ourPhone: `+${env.WA_PHONE_NUMBER_ID}`,
  });

  const data = parsed.data;

  switch (data.action) {
    case "send_inbound": {
      // Build the webhook payload and POST it to our own webhook endpoint
      const payload = provider.buildInboundPayload({
        from: data.from,
        type: data.type,
        text: data.text,
        buttonId: data.buttonId,
        buttonTitle: data.buttonTitle,
        listRowId: data.listRowId,
        listRowTitle: data.listRowTitle,
        imageCaption: data.imageCaption,
      });
      const signature = provider.signPayload(payload);
      const webhookUrl = `${request.nextUrl.origin}/api/webhooks/whatsapp`;
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": signature,
        },
        body: payload,
      });
      return Response.json({ ok: res.ok, status: res.status });
    }

    case "send_status": {
      const payload = provider.buildStatusPayload({
        messageId: data.messageId,
        recipientPhone: data.recipientPhone,
        status: data.status,
      });
      const signature = provider.signPayload(payload);
      const webhookUrl = `${request.nextUrl.origin}/api/webhooks/whatsapp`;
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": signature,
        },
        body: payload,
      });
      return Response.json({ ok: res.ok, status: res.status });
    }

    case "set_outage":
      provider.setOutage(data.active);
      return Response.json({ outage: data.active });

    case "set_duplicate_next":
      provider.setDuplicateNextEvent();
      return Response.json({ duplicateNextEvent: true });

    case "set_service_window":
      provider.setServiceWindow(data.phone, data.timestamp ? new Date(data.timestamp) : null);
      return Response.json({ ok: true });

    case "reset":
      resetFakeStore();
      return Response.json({ ok: true });
  }
}
