/**
 * POST /api/webhooks/whatsapp — receives Meta webhook events
 * GET  /api/webhooks/whatsapp — Meta hub.challenge verification
 *
 * Reliability contract:
 *  - Signature invalid          → 403  (Meta will not retry)
 *  - DB persist fails           → 500  (Meta WILL retry — event is not lost)
 *  - Persist ok, enqueue fails  → 500  (Meta retries; sweeper also rescues)
 *  - Duplicate providerEventId  → 200  (idempotent, already in DB)
 *  - Everything ok              → 200
 *
 * Race safety: we CREATE the row and catch Prisma P2002 (unique violation)
 * instead of findUnique-then-create, which has a TOCTOU race under concurrent
 * delivery of the same event.
 */
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/providers";

export const runtime = "nodejs";

// Prisma unique-constraint violation code
const P2002 = "P2002";

type WebhookPayloadShape = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ id?: string }>;
        statuses?: Array<{ id?: string; status?: string }>;
      };
    }>;
  }>;
};

// ─── GET: hub.challenge verification ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const mode      = searchParams.get("hub.mode")         ?? undefined;
  const token     = searchParams.get("hub.verify_token") ?? undefined;
  const challenge = searchParams.get("hub.challenge")    ?? undefined;

  const provider = getProvider();
  const result = await provider.verifyWebhook({ mode, token, challenge });

  if (!result.valid) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(result.challenge ?? "ok", { status: 200 });
}

// ─── POST: inbound webhook ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Read raw body — must happen before any other await to capture it intact
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? undefined;

  // 2. Verify signature — reject immediately, Meta will not retry 403s
  const provider = getProvider();
  const { valid } = await provider.verifyWebhook({ signature, rawBody });
  if (!valid) {
    console.warn("[Webhook] Invalid signature, rejecting");
    return new Response("Forbidden", { status: 403 });
  }

  // 3. Parse body for event ids
  let payload: WebhookPayloadShape;
  try {
    payload = JSON.parse(rawBody) as WebhookPayloadShape;
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  const eventIds = extractEventIds(payload);
  if (eventIds.length === 0) {
    return new Response("ok", { status: 200 }); // heartbeat / status-only with no ids
  }

  // 4. Persist each event (race-safe via unique constraint + P2002 catch)
  //    If DB is down this throws → 500 → Meta retries the webhook.
  const persistedIds: string[] = [];
  const rawJson = JSON.parse(rawBody) as object;

  for (const providerEventId of eventIds) {
    try {
      const saved = await prisma.webhookEvent.create({
        data: {
          providerEventId,
          rawPayload: rawJson,
          provider: "meta",
        },
      });
      persistedIds.push(saved.id);
    } catch (err: unknown) {
      if (isPrismaError(err, P2002)) {
        // Duplicate delivery — already in DB, nothing to do
        console.info(`[Webhook] Duplicate event ${providerEventId}, skipping`);
        continue;
      }
      // Any other DB error: let it propagate → 500 → Meta retries
      console.error(`[Webhook] Failed to persist event ${providerEventId}:`, err);
      throw err;
    }
  }

  // 5. Enqueue jobs for persisted events
  //    If Redis is down after DB write succeeded: return 500 so Meta retries.
  //    The sweeper job will also rescue any persisted-but-not-enqueued rows.
  if (persistedIds.length > 0) {
    const { webhookQueue } = await import("@/queues");

    for (const dbId of persistedIds) {
      await webhookQueue.add(
        "process-webhook",
        { webhookEventId: dbId, rawPayload: rawBody, provider: "meta" },
        { jobId: `webhook_${dbId}` }
      );
    }
  }

  return new Response("ok", { status: 200 });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractEventIds(payload: WebhookPayloadShape): string[] {
  const ids: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.id) ids.push(`msg_${msg.id}`);
      }
      for (const status of change.value?.statuses ?? []) {
        if (status.id && status.status) ids.push(`status_${status.id}_${status.status}`);
      }
    }
  }
  return ids;
}

function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === code
  );
}
