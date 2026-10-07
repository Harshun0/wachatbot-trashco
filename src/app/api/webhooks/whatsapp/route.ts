/**
 * POST /api/webhooks/whatsapp — receives Meta webhook events
 * GET  /api/webhooks/whatsapp — Meta hub.challenge verification
 *
 * Rules:
 *  - Respond 200 fast; do heavy work in a BullMQ job
 *  - Persist raw event before enqueuing (survives queue failures)
 *  - Use providerEventId as idempotency key (unique DB constraint)
 *  - Reject invalid signatures with 403
 */
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/providers";

export const runtime = "nodejs"; // Need crypto / BullMQ

const isDev = process.env.NODE_ENV !== "production";

// ─── GET: hub.challenge verification ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const mode = searchParams.get("hub.mode") ?? undefined;
  const token = searchParams.get("hub.verify_token") ?? undefined;
  const challenge = searchParams.get("hub.challenge") ?? undefined;

  const provider = getProvider();
  const result = await provider.verifyWebhook({ mode, token, challenge });

  if (!result.valid) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(result.challenge ?? "ok", { status: 200 });
}

// ─── POST: inbound webhook ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // Read raw body as text (needed for HMAC verification)
    const rawBody = await request.text();

    // Extract signature from header
    const signature = request.headers.get("x-hub-signature-256") ?? undefined;

    const provider = getProvider();
    const { valid } = await provider.verifyWebhook({ signature, rawBody });

    if (!valid) {
      console.warn("[Webhook] Invalid signature, rejecting request");
      return new Response("Forbidden", { status: 403 });
    }

    // Parse for providerEventId without fully processing
    let payload: { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id?: string }>; statuses?: Array<{ id?: string; status?: string }> } }> }> };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Bad Request: invalid JSON", { status: 400 });
    }

    // Collect all event ids from this payload
    const eventIds: string[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          if (msg.id) eventIds.push(`msg_${msg.id}`);
        }
        for (const status of change.value?.statuses ?? []) {
          if (status.id && status.status) eventIds.push(`status_${status.id}_${status.status}`);
        }
      }
    }

    if (eventIds.length === 0) {
      // Heartbeat / test event — just ack
      return new Response("ok", { status: 200 });
    }

    // Try to persist + enqueue. If DB/Redis are not configured yet (e.g. dev
    // with placeholder URLs) we still ack 200 so the dev UI doesn't show errors.
    try {
      // Lazy-import queue so a missing Redis doesn't crash the module at load time
      const { webhookQueue } = await import("@/queues");

      const persistedIds: string[] = [];
      for (const providerEventId of eventIds) {
        const existing = await prisma.webhookEvent.findUnique({ where: { providerEventId } });
        if (existing) {
          console.info(`[Webhook] Duplicate event ${providerEventId}, skipping`);
          continue;
        }

        const saved = await prisma.webhookEvent.create({
          data: {
            providerEventId,
            rawPayload: JSON.parse(rawBody),
            provider: "meta",
          },
        });
        persistedIds.push(saved.id);
      }

      for (const dbId of persistedIds) {
        await webhookQueue.add(
          "process-webhook",
          { webhookEventId: dbId, rawPayload: rawBody, provider: "meta" },
          { jobId: `webhook_${dbId}` }
        );
      }
    } catch (persistErr) {
      // Log the real error so it shows in the Next.js terminal
      console.error("[Webhook] Failed to persist/enqueue — DB or Redis not reachable:", persistErr);
      // In dev, return the error so the UI can show it; in prod keep it opaque
      if (isDev) {
        return Response.json(
          { error: "DB/Redis not reachable", detail: String(persistErr) },
          { status: 500 }
        );
      }
      // In production: still ack 200 so Meta doesn't disable the webhook,
      // but log for alerting. The raw event is lost — a proper retry / dead-letter
      // strategy should be wired before going live.
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[Webhook] Unexpected error:", err);
    return Response.json(
      { error: isDev ? String(err) : "Internal server error" },
      { status: 500 }
    );
  }
}
