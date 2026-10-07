/**
 * FakeProvider — deterministic, in-process WhatsApp provider for local dev.
 *
 * Features:
 *  - Emits payloads in real Meta webhook format
 *  - Enforces 24-hour service window (non-templates rejected outside window)
 *  - Simulates delivered/read/failed status updates
 *  - Can simulate duplicate events (same event id twice)
 *  - Can simulate provider outage (throws ProviderError with retryable=true)
 *  - Stores sent messages and status updates in memory for the dev UI
 *  - Accepts inbound messages from the dev UI (/dev/whatsapp)
 */
import { createHmac } from "crypto";
import type {
  WhatsAppProvider,
  TextContent,
  TemplateContent,
  InteractiveContent,
  ParsedWebhookEvent,
  SendResult,
  WebhookVerification,
} from "../types";
import { ProviderError, ServiceWindowError } from "../types";
import type { MetaWebhookPayload, MetaMessage, MetaStatus } from "./fake-meta-types";

// Re-export fake Meta types so the dev page can import them easily
export type { MetaWebhookPayload };

// ─── State ────────────────────────────────────────────────────────────────────

export interface FakeSentMessage {
  id: string;
  to: string;
  type: string;
  content: unknown;
  sentAt: Date;
}

export interface FakeStatusEvent {
  messageId: string;
  to: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
}

export interface FakeInboundEvent {
  id: string;
  from: string;
  type: string;
  content: unknown;
  timestamp: Date;
}

// Singleton in-memory store (survives across calls in a single process)
const store = {
  sentMessages: [] as FakeSentMessage[],
  statusEvents: [] as FakeStatusEvent[],
  inboundQueue: [] as FakeInboundEvent[],
  conversationWindows: new Map<string, Date>(), // phone → last inbound timestamp
  outageMode: false,
  duplicateNextEvent: false,
  messageCounter: 0,
};

export function getFakeStore() {
  return store;
}

export function resetFakeStore() {
  store.sentMessages = [];
  store.statusEvents = [];
  store.inboundQueue = [];
  store.conversationWindows = new Map();
  store.outageMode = false;
  store.duplicateNextEvent = false;
  store.messageCounter = 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextWamid(): string {
  store.messageCounter += 1;
  return `wamid.fake${store.messageCounter.toString().padStart(8, "0")}`;
}

function toE164(phone: string): string {
  return phone.startsWith("+") ? phone : `+${phone}`;
}

/** Returns true if the 24-hour service window is open for this phone. */
export function isInServiceWindow(phone: string, now = new Date()): boolean {
  const last = store.conversationWindows.get(toE164(phone));
  if (!last) return false;
  return now.getTime() - last.getTime() <= 24 * 60 * 60 * 1000;
}

/** Record an inbound message to open/extend the service window. */
export function recordInbound(phone: string, timestamp = new Date()): void {
  store.conversationWindows.set(toE164(phone), timestamp);
}

// ─── FakeProvider class ───────────────────────────────────────────────────────

export class FakeProvider implements WhatsAppProvider {
  private readonly verifyToken: string;
  private readonly appSecret: string;
  private readonly ourPhone: string; // our number, used as "to" in inbound events

  constructor(cfg: {
    verifyToken: string;
    appSecret: string;
    ourPhone?: string;
  }) {
    this.verifyToken = cfg.verifyToken;
    this.appSecret = cfg.appSecret;
    this.ourPhone = cfg.ourPhone ?? "+919900000000";
  }

  // ─── Sending ───────────────────────────────────────────────────────────────

  async sendText(to: string, body: string): Promise<SendResult> {
    this.checkOutage();
    this.checkServiceWindow(to, "text");
    const id = nextWamid();
    store.sentMessages.push({ id, to, type: "text", content: { body }, sentAt: new Date() });
    this.scheduleStatusUpdates(id, to);
    return { providerId: id };
  }

  async sendTemplate(to: string, template: TemplateContent): Promise<SendResult> {
    this.checkOutage();
    // Templates are allowed outside the service window — no window check
    const id = nextWamid();
    store.sentMessages.push({ id, to, type: "template", content: template, sentAt: new Date() });
    this.scheduleStatusUpdates(id, to);
    return { providerId: id };
  }

  async sendInteractive(to: string, interactive: InteractiveContent): Promise<SendResult> {
    this.checkOutage();
    this.checkServiceWindow(to, "interactive");
    const id = nextWamid();
    store.sentMessages.push({ id, to, type: "interactive", content: interactive, sentAt: new Date() });
    this.scheduleStatusUpdates(id, to);
    return { providerId: id };
  }

  // ─── Webhook verification ──────────────────────────────────────────────────

  async verifyWebhook(params: {
    mode?: string;
    token?: string;
    challenge?: string;
    signature?: string;
    rawBody?: string;
  }): Promise<WebhookVerification> {
    if (params.mode !== undefined) {
      const valid =
        params.mode === "subscribe" && params.token === this.verifyToken;
      return { valid, challenge: valid ? params.challenge : undefined };
    }
    if (!params.signature || !params.rawBody) return { valid: false };
    const expected = createHmac("sha256", this.appSecret)
      .update(params.rawBody)
      .digest("hex");
    const sig = params.signature.replace("sha256=", "");
    return { valid: sig === expected };
  }

  // ─── Webhook parsing ───────────────────────────────────────────────────────

  async parseWebhook(rawBody: string): Promise<ParsedWebhookEvent[]> {
    const payload = JSON.parse(rawBody) as MetaWebhookPayload;
    const events: ParsedWebhookEvent[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const val = change.value;

        for (const msg of val.messages ?? []) {
          // If msg is inbound, record it to open/extend the service window
          recordInbound(`+${msg.from}`);
          store.conversationWindows.set(`+${msg.from}`, new Date(Number(msg.timestamp) * 1000));

          const event: ParsedWebhookEvent = {
            kind: "message",
            providerEventId: `msg_${msg.id}`,
            providerId: msg.id,
            fromPhone: `+${msg.from}`,
            toPhone: `+${val.metadata.phone_number_id}`,
            timestamp: new Date(Number(msg.timestamp) * 1000),
            contentType: (msg.type ?? "unknown") as ParsedWebhookEvent extends { kind: "message"; contentType: infer T } ? T : never,
            content: extractFakeContent(msg),
          };
          events.push(event);

          if (store.duplicateNextEvent) {
            events.push({ ...event, providerEventId: `msg_${msg.id}` }); // same id, tests idempotency
            store.duplicateNextEvent = false;
          }
        }

        for (const status of val.statuses ?? []) {
          const s = status.status as "sent" | "delivered" | "read" | "failed";
          if (!["sent", "delivered", "read", "failed"].includes(s)) continue;
          const event: ParsedWebhookEvent = {
            kind: "status",
            providerEventId: `status_${status.id}_${status.status}`,
            providerId: status.id,
            status: s,
            timestamp: new Date(Number(status.timestamp) * 1000),
            recipientPhone: `+${status.recipient_id}`,
          };
          events.push(event);
        }
      }
    }

    return events;
  }

  // ─── Media download ────────────────────────────────────────────────────────

  async downloadMedia(_mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    this.checkOutage();
    // Return a 1×1 transparent PNG as stub
    const stub = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    return { buffer: stub, mimeType: "image/png" };
  }

  // ─── Simulation helpers (called by dev UI) ─────────────────────────────────

  /**
   * Simulate an inbound message from a contact.
   * Returns the raw webhook payload string (same format Meta would send).
   */
  buildInboundPayload(params: {
    from: string;
    type: "text" | "image" | "button_reply" | "list_reply";
    text?: string;
    buttonId?: string;
    buttonTitle?: string;
    listRowId?: string;
    listRowTitle?: string;
    imageCaption?: string;
    timestamp?: Date;
  }): string {
    const ts = Math.floor((params.timestamp ?? new Date()).getTime() / 1000).toString();
    const msgId = nextWamid();
    const from = params.from.replace("+", "");
    const ourPhone = this.ourPhone.replace("+", "");

    let msgBlock: MetaMessage;
    if (params.type === "text") {
      msgBlock = { id: msgId, from, timestamp: ts, type: "text", text: { body: params.text ?? "" } };
    } else if (params.type === "image") {
      msgBlock = {
        id: msgId, from, timestamp: ts, type: "image",
        image: { id: `fakemedia_${msgId}`, mime_type: "image/jpeg", sha256: "fakehash", caption: params.imageCaption },
      };
    } else if (params.type === "button_reply") {
      msgBlock = {
        id: msgId, from, timestamp: ts, type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: params.buttonId ?? "btn_1", title: params.buttonTitle ?? "Yes" } },
      };
    } else {
      msgBlock = {
        id: msgId, from, timestamp: ts, type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: params.listRowId ?? "row_1", title: params.listRowTitle ?? "Item 1" } },
      };
    }

    const payload: MetaWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "fake_waba_id",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: ourPhone, phone_number_id: ourPhone },
            contacts: [{ profile: { name: `FakeUser_${from}` }, wa_id: from }],
            messages: [msgBlock],
          },
        }],
      }],
    };

    // Also record inbound to open service window
    store.inboundQueue.push({ id: msgId, from: params.from, type: params.type, content: msgBlock, timestamp: new Date() });
    recordInbound(params.from);

    return JSON.stringify(payload);
  }

  /**
   * Build a status update payload for an existing sent message.
   */
  buildStatusPayload(params: {
    messageId: string;
    recipientPhone: string;
    status: "delivered" | "read" | "failed";
    timestamp?: Date;
  }): string {
    const ts = Math.floor((params.timestamp ?? new Date()).getTime() / 1000).toString();
    const recipient = params.recipientPhone.replace("+", "");
    const ourPhone = this.ourPhone.replace("+", "");

    const statusBlock: MetaStatus = {
      id: params.messageId,
      recipient_id: recipient,
      status: params.status,
      timestamp: ts,
    };

    const payload: MetaWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "fake_waba_id",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: ourPhone, phone_number_id: ourPhone },
            statuses: [statusBlock],
          },
        }],
      }],
    };

    return JSON.stringify(payload);
  }

  /**
   * Sign a payload string with the app secret (for testing webhook signature validation).
   */
  signPayload(rawBody: string): string {
    return "sha256=" + createHmac("sha256", this.appSecret).update(rawBody).digest("hex");
  }

  /** Enable/disable outage simulation. */
  setOutage(active: boolean): void {
    store.outageMode = active;
  }

  /** Next event produced by parseWebhook will be emitted twice (same providerEventId). */
  setDuplicateNextEvent(): void {
    store.duplicateNextEvent = true;
  }

  /**
   * Manually set or clear the service window for a phone number.
   * Pass null to clear (simulate expired window).
   */
  setServiceWindow(phone: string, timestamp: Date | null): void {
    if (timestamp === null) {
      store.conversationWindows.delete(toE164(phone));
    } else {
      store.conversationWindows.set(toE164(phone), timestamp);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private checkOutage(): void {
    if (store.outageMode) {
      throw new ProviderError("Fake provider outage simulated", "OUTAGE", true);
    }
  }

  private checkServiceWindow(phone: string, type: string): void {
    if (!isInServiceWindow(phone)) {
      throw new ServiceWindowError(
        `Outside 24-hour service window for ${phone}: ${type} messages not allowed`
      );
    }
  }

  /**
   * Schedules simulated status updates (sent → delivered → read) with small delays.
   * In test environments delays are set to 0 so tests aren't slow.
   */
  private scheduleStatusUpdates(messageId: string, to: string): void {
    const delay = process.env.NODE_ENV === "test" ? 0 : 500;
    const recipientId = to.replace("+", "");
    const ourPhone = this.ourPhone.replace("+", "");

    const scheduleStatus = (status: "sent" | "delivered" | "read", ms: number) => {
      setTimeout(() => {
        const ts = Math.floor(Date.now() / 1000).toString();
        const statusBlock: MetaStatus = { id: messageId, recipient_id: recipientId, status, timestamp: ts };
        const payload: MetaWebhookPayload = {
          object: "whatsapp_business_account",
          entry: [{
            id: "fake_waba_id",
            changes: [{
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: ourPhone, phone_number_id: ourPhone },
                statuses: [statusBlock],
              },
            }],
          }],
        };
        store.statusEvents.push({ messageId, to, status, timestamp: new Date() });
        // Emit on the global event bus so the dev UI and tests can observe
        if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__fakeStatusCallback) {
          ((globalThis as Record<string, unknown>).__fakeStatusCallback as (p: string) => void)(JSON.stringify(payload));
        }
      }, ms);
    };

    scheduleStatus("sent", delay);
    scheduleStatus("delivered", delay * 2);
    scheduleStatus("read", delay * 3);
  }
}

function extractFakeContent(msg: MetaMessage): unknown {
  const type = msg.type as string;
  if (type === "text") return msg.text;
  if (type === "image") return msg.image;
  if (type === "interactive") return msg.interactive;
  if (type === "button") return msg.button;
  return { raw: msg };
}
