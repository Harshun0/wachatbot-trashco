# wacrm-app — WhatsApp CRM Foundation

A Next.js 16 (App Router) application providing the WhatsApp messaging foundation for a scrap/recycling CRM. This layer handles inbound webhooks, outbound messaging, a 24-hour service window, and a full fake provider for local development — no WhatsApp account needed to get started.

---

## Table of Contents

1. [Tech stack](#tech-stack)
2. [Prerequisites](#prerequisites)
3. [Local setup](#local-setup)
4. [Running the app](#running-the-app)
5. [Webhook simulation (dev UI)](#webhook-simulation-dev-ui)
6. [Switching to real Meta credentials](#switching-to-real-meta-credentials)
7. [Project structure](#project-structure)
8. [API reference](#api-reference)
9. [Testing](#testing)
10. [What is done / not done / assumptions](#what-is-done--not-done--assumptions)

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 App Router, TypeScript 5 |
| Database | PostgreSQL via [Neon](https://neon.tech) (serverless) |
| ORM | Prisma 6 |
| Queue / jobs | BullMQ 6 |
| Queue backend | Redis via [Upstash](https://upstash.com) (serverless) |
| Validation | Zod 4 |
| Tests | Vitest 5 |
| Styling | Tailwind CSS 4 |

---

## Prerequisites

- Node.js ≥ 20
- A free [Neon](https://neon.tech) project (get a `DATABASE_URL`)
- A free [Upstash](https://upstash.com) Redis database (get a `REDIS_URL`)

No Docker, no local Postgres, no local Redis required.

---

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your real values:

```env
# Neon Postgres — copy from your Neon project dashboard
DATABASE_URL="postgresql://user:password@ep-xxx.us-east-1.aws.neon.tech/wacrm?sslmode=require"

# Upstash Redis — copy from your Upstash console (use the rediss:// TLS URL)
REDIS_URL="rediss://default:password@global-master.upstash.io:6379"

# Keep as "fake" for local dev
WA_PROVIDER="fake"

# These placeholders are fine while WA_PROVIDER=fake
WA_PHONE_NUMBER_ID="placeholder"
WA_WABA_ID="placeholder"
WA_ACCESS_TOKEN="placeholder"
WA_APP_SECRET="a_secret_at_least_16_chars"
WA_VERIFY_TOKEN="my_verify_token"
```

> `WA_APP_SECRET` is used to sign/verify fake webhook payloads locally. It can be any string when using the fake provider.

### 3. Set up the database

Push the Prisma schema to your Neon database:

```bash
npm run db:push
```

For tracked migrations (recommended before production):

```bash
npm run db:migrate
```

---

## Running the app

You need two processes: the Next.js dev server and the BullMQ worker.

**Terminal 1 — Next.js dev server:**
```bash
npm run dev
```

**Terminal 2 — BullMQ worker:**
```bash
npm run worker
```

The worker processes webhook jobs and outbound message jobs. Without it running, messages will be queued but not processed.

---

## Webhook simulation (dev UI)

Open [http://localhost:3000/dev/whatsapp](http://localhost:3000/dev/whatsapp) in your browser.

The simulator lets you act as a Trader or Recycler and drive the entire WhatsApp flow locally:

| Action | What it does |
|---|---|
| **Send text** | Simulates an inbound text from the selected contact |
| **📷 Image** | Simulates an inbound image message |
| **🔘 Button Reply** | Simulates tapping a quick-reply button |
| **📋 List Reply** | Simulates selecting a list row |
| **Trigger status** | Posts a delivered/read/failed status for a sent message id |
| **Open 24h Window** | Sets the service window open (allows non-template outbound) |
| **Close Window** | Clears the service window (only templates allowed outbound) |
| **Simulate Outage** | All sends throw a retryable `ProviderError` |
| **Duplicate Next Event** | Next inbound is emitted twice — tests idempotency |
| **Reset Store** | Clears all fake state |

Each action POSTs to `/api/dev/whatsapp`, which builds a real Meta-format payload, signs it with `WA_APP_SECRET`, and POSTs it to `/api/webhooks/whatsapp` — going through the exact same code path as a real Meta webhook.

### Testing the 24-hour window rule manually

1. Click **Close Window** to ensure the window is closed.
2. Try sending a text from the dev UI — the webhook will be accepted but the worker will log a `ServiceWindowError`.
3. Click **Open 24h Window**, then try again — it succeeds.
4. Alternatively, send an inbound message; this automatically opens the window.

### Manually sending a webhook with curl

```bash
# Build and sign a payload yourself
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "your_WA_APP_SECRET" | awk '{print "sha256="$2}')

curl -X POST http://localhost:3000/api/webhooks/whatsapp \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: $SIG" \
  -d "$BODY"
```

---

## Switching to real Meta credentials

1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com), add the **WhatsApp** product.
2. Get your Phone Number ID, WABA ID, and a System User access token.
3. Update `.env`:

```env
WA_PROVIDER="meta"
WA_PHONE_NUMBER_ID="your_real_phone_number_id"
WA_WABA_ID="your_real_waba_id"
WA_ACCESS_TOKEN="your_system_user_token"
WA_APP_SECRET="your_app_secret"          # from App Settings → Basic
WA_VERIFY_TOKEN="choose_any_secret_string"
```

4. In the Meta App dashboard, configure your webhook:
   - **Callback URL**: `https://your-domain.com/api/webhooks/whatsapp`
   - **Verify Token**: the value you set in `WA_VERIFY_TOKEN`
   - Subscribe to the `messages` field.

5. Restart the dev server. No code changes needed — the provider factory (`src/providers/index.ts`) picks up the new `WA_PROVIDER=meta` and returns `MetaCloudProvider` automatically.

> **Testing with ngrok**: run `ngrok http 3000` and use the HTTPS URL as your callback URL while developing locally with real Meta credentials.

---

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── webhooks/whatsapp/route.ts   # POST + GET webhook endpoint
│   │   ├── messages/send/route.ts       # POST enqueue outbound message
│   │   └── dev/whatsapp/route.ts        # Dev-only simulator API (blocked in prod)
│   └── dev/
│       └── whatsapp/page.tsx            # Dev simulator UI
├── lib/
│   ├── env.ts                           # Zod env validation (fail-fast)
│   ├── prisma.ts                        # Prisma client singleton
│   └── redis.ts                         # IORedis singleton for BullMQ
├── providers/
│   ├── types.ts                         # WhatsAppProvider interface + shared types
│   ├── index.ts                         # Provider factory (fake | meta)
│   ├── meta/
│   │   ├── index.ts                     # MetaCloudProvider
│   │   └── payload-types.ts             # Raw Meta payload shapes (internal only)
│   └── fake/
│       ├── index.ts                     # FakeProvider + in-memory store
│       └── fake-meta-types.ts           # Meta payload subset for fake
├── queues/
│   ├── index.ts                         # BullMQ queue definitions
│   └── worker.ts                        # Webhook + send workers (run separately)
└── __tests__/
    ├── setup.ts                         # Vitest global setup (env + store reset)
    └── fake-provider.test.ts            # 20 unit tests

prisma/
└── schema.prisma                        # 7 models: org, user, company, contact,
                                         #   conversation, message, webhook_event,
                                         #   audit_event
```

---

## API reference

### `GET /api/webhooks/whatsapp`

Meta hub.challenge verification. Query params: `hub.mode`, `hub.verify_token`, `hub.challenge`. Returns the challenge string on success, `403` on mismatch.

### `POST /api/webhooks/whatsapp`

Receives Meta webhook events.

- Validates `x-hub-signature-256` header — returns `403` on failure.
- Persists raw payload to `webhook_events` with `providerEventId` as idempotency key.
- Enqueues a BullMQ job and returns `200 ok` immediately.
- Duplicate events (same `providerEventId`) are silently skipped.

### `POST /api/messages/send`

Enqueues an outbound message. Returns `202` with the DB message id.

```json
{
  "organizationId": "org_cuid",
  "conversationId": "conv_cuid",
  "contentType": "text",
  "content": { "type": "text", "body": "Hello!" }
}
```

Response:
```json
{ "messageId": "msg_cuid", "status": "queued" }
```

---

## Testing

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

The test suite covers:
- Duplicate webhook → single `providerEventId` (idempotency)
- Invalid signature → rejected
- Correct signature → accepted
- Hub challenge → verified / rejected
- 24-hour service window open/closed/expired
- `sendText` / `sendInteractive` blocked outside window
- `sendTemplate` allowed outside window
- Outage mode → retryable `ProviderError`
- Recovery after outage cleared
- `parseWebhook` for text and status events

All tests run in-memory with no database or Redis connection required.

---

## What is done / not done / assumptions

### ✅ Done

- Env validation with Zod (fails fast, clear error messages)
- Prisma schema: `organizations`, `users`, `companies` (TRADER/RECYCLER + GST), `contacts` (opt-in source/timestamp/scope/opt-out), `conversations` (service window tracking), `messages` (providerId unique, direction, content, status lifecycle), `webhook_events` (providerEventId unique, raw payload), `audit_events` — every business table has `organizationId`
- `WhatsAppProvider` interface with `sendText`, `sendTemplate`, `sendInteractive`, `verifyWebhook`, `parseWebhook`, `downloadMedia`
- Meta payload types isolated inside `src/providers/meta/` only
- `FakeProvider`: emits real Meta-format payloads, enforces 24-hour window, simulates delivered/read/failed, duplicate events, provider outage
- `/dev/whatsapp` simulator UI — text, image, button reply, list reply, status triggers, outage toggle, window control, store reset
- `MetaCloudProvider`: Graph API v21.0 calls, GET hub.challenge, X-Hub-Signature-256 with `timingSafeEqual`, media download
- `POST /api/webhooks/whatsapp`: signature check, raw event persistence, idempotency via `providerEventId` unique constraint, BullMQ enqueue, fast 200 response
- `POST /api/messages/send`: Zod validation, org-scoped conversation lookup, PENDING message creation, BullMQ enqueue
- BullMQ webhook worker: idempotent, resolves contact+conversation, saves inbound message, updates outbound message status
- BullMQ send worker: bounded retries (3), exponential backoff, dead-letter (`DEAD`) state after exhaustion, `UnrecoverableError` on dead messages
- 20 Vitest tests, all passing, zero TypeScript errors

### ❌ Not built yet (by design)

- Lot, matching, bid, and CRM screens
- Authentication / session management
- Org onboarding flow
- Media storage (images are downloaded to a buffer; S3/R2 upload not wired)
- Real-time UI updates (webhook events don't push to browser yet — polling only in dev UI)
- Bull Board / queue monitoring UI
- Rate limiting on the webhook endpoint
- Database migrations history (using `db push` for now)

### Assumptions made

1. **One organization per deployment initially.** The webhook worker falls back to `findFirst` org when `organizationId` is not yet on the webhook event. This will be replaced once org routing (by WABA ID or phone number ID) is wired up.
2. **Inbound messages auto-create contacts.** A contact arriving for the first time is created with `optInSource: INBOUND_MESSAGE`. The spec implies opt-in should be explicit — this is a safe default that can be tightened.
3. **Service window is phone-scoped on the fake provider's in-memory store.** In production the source of truth is `conversations.lastInboundAt` in the DB, which the worker keeps up to date.
4. **Media download returns a buffer only.** The spec mentions downloading by media ID; the buffer is returned to the caller. Persisting to object storage is left to the media-handling module.
5. **`WA_PHONE_NUMBER_ID` is the raw numeric id, not E.164.** The fake provider prepends `+` when needed. Adjust if your Meta dashboard shows it differently.
6. **Upstash Redis with TLS.** If your Redis URL starts with `rediss://` the client enables TLS automatically. Plain `redis://` (non-TLS) also works for local Redis.
