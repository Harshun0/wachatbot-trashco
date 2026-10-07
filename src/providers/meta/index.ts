/**
 * MetaCloudProvider — real Meta Cloud API integration.
 *
 * Responsibilities:
 *  - Send messages via Graph API
 *  - Verify GET hub.challenge
 *  - Verify X-Hub-Signature-256 on POST webhooks
 *  - Parse raw Meta payloads into internal events
 *  - Download media by media id
 */
import { createHmac, timingSafeEqual } from "crypto";
import type {
  WhatsAppProvider,
  TextContent,
  TemplateContent,
  InteractiveContent,
  OutboundContent,
  ParsedWebhookEvent,
  SendResult,
  WebhookVerification,
  InboundContentType,
} from "../types";
import { ProviderError } from "../types";
import type {
  MetaWebhookPayload,
  MetaSendResponse,
  MetaMediaUrlResponse,
  MetaErrorResponse,
  MetaMessageType,
  MetaMessage,
} from "./payload-types";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export class MetaCloudProvider implements WhatsAppProvider {
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly appSecret: string;
  private readonly verifyToken: string;

  constructor(cfg: {
    phoneNumberId: string;
    accessToken: string;
    appSecret: string;
    verifyToken: string;
  }) {
    this.phoneNumberId = cfg.phoneNumberId;
    this.accessToken = cfg.accessToken;
    this.appSecret = cfg.appSecret;
    this.verifyToken = cfg.verifyToken;
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  async sendText(to: string, body: string): Promise<SendResult> {
    const content: TextContent = { type: "text", body };
    return this.send(to, content);
  }

  async sendTemplate(to: string, template: TemplateContent): Promise<SendResult> {
    return this.send(to, template);
  }

  async sendInteractive(to: string, interactive: InteractiveContent): Promise<SendResult> {
    return this.send(to, interactive);
  }

  private async send(to: string, content: OutboundContent): Promise<SendResult> {
    const body = this.buildBody(to, content);

    const res = await fetch(
      `${GRAPH_BASE}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = (await res.json()) as MetaErrorResponse;
      const code = String(err.error?.code ?? res.status);
      const msg = err.error?.message ?? `HTTP ${res.status}`;
      // 130429 = rate limit, 131047 = re-engagement needed → retryable
      const retryable = ["130429", "500", "503"].includes(code);
      throw new ProviderError(`Meta API error: ${msg}`, code, retryable);
    }

    const data = (await res.json()) as MetaSendResponse;
    const providerId = data.messages[0]?.id;
    if (!providerId) {
      throw new ProviderError("Meta API returned no message id", "NO_MESSAGE_ID", false);
    }
    return { providerId };
  }

  private buildBody(to: string, content: OutboundContent): Record<string, unknown> {
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
    switch (content.type) {
      case "text":
        return { ...base, type: "text", text: { body: content.body, preview_url: content.previewUrl ?? false } };
      case "template":
        return { ...base, type: "template", template: { name: content.name, language: content.language, components: content.components } };
      case "interactive":
        return { ...base, type: "interactive", interactive: content.interactive };
    }
  }

  // ─── Webhook verification ─────────────────────────────────────────────────

  async verifyWebhook(params: {
    mode?: string;
    token?: string;
    challenge?: string;
    signature?: string;
    rawBody?: string;
  }): Promise<WebhookVerification> {
    // GET: hub.challenge verification
    if (params.mode !== undefined) {
      const valid =
        params.mode === "subscribe" && params.token === this.verifyToken;
      return { valid, challenge: valid ? params.challenge : undefined };
    }

    // POST: X-Hub-Signature-256 verification
    if (!params.signature || !params.rawBody) {
      return { valid: false };
    }

    const expected = this.computeSignature(params.rawBody);
    const sig = params.signature.replace("sha256=", "");

    try {
      const valid = timingSafeEqual(
        Buffer.from(sig, "hex"),
        Buffer.from(expected, "hex")
      );
      return { valid };
    } catch {
      return { valid: false };
    }
  }

  private computeSignature(rawBody: string): string {
    return createHmac("sha256", this.appSecret).update(rawBody).digest("hex");
  }

  // ─── Webhook parsing ──────────────────────────────────────────────────────

  async parseWebhook(rawBody: string): Promise<ParsedWebhookEvent[]> {
    const payload = JSON.parse(rawBody) as MetaWebhookPayload;
    const events: ParsedWebhookEvent[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const val = change.value;
        const toPhone = `+${val.metadata.phone_number_id}`;

        for (const msg of val.messages ?? []) {
          const eventId = `msg_${msg.id}`;
          events.push({
            kind: "message",
            providerEventId: eventId,
            providerId: msg.id,
            fromPhone: `+${msg.from}`,
            toPhone,
            timestamp: new Date(Number(msg.timestamp) * 1000),
            contentType: metaTypeToInternal(msg.type),
            content: extractContent(msg as MetaMessage & Record<string, unknown>),
          });
        }

        for (const status of val.statuses ?? []) {
          const eventId = `status_${status.id}_${status.status}`;
          const normalised = status.status as "sent" | "delivered" | "read" | "failed";
          if (!["sent", "delivered", "read", "failed"].includes(normalised)) continue;
          events.push({
            kind: "status",
            providerEventId: eventId,
            providerId: status.id,
            status: normalised,
            timestamp: new Date(Number(status.timestamp) * 1000),
            recipientPhone: `+${status.recipient_id}`,
            errorCode: status.errors?.[0]?.code?.toString(),
            errorTitle: status.errors?.[0]?.title,
          });
        }
      }
    }

    return events;
  }

  // ─── Media download ───────────────────────────────────────────────────────

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // Step 1: get the download URL
    const urlRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!urlRes.ok) {
      throw new ProviderError(`Failed to get media URL for ${mediaId}`, "MEDIA_URL_FAILED", true);
    }
    const urlData = (await urlRes.json()) as MetaMediaUrlResponse;

    // Step 2: download the binary
    const mediaRes = await fetch(urlData.url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!mediaRes.ok) {
      throw new ProviderError(`Failed to download media ${mediaId}`, "MEDIA_DOWNLOAD_FAILED", true);
    }

    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    return { buffer, mimeType: urlData.mime_type };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function metaTypeToInternal(type: MetaMessageType): InboundContentType {
  const map: Partial<Record<MetaMessageType, InboundContentType>> = {
    text: "text",
    image: "image",
    audio: "audio",
    video: "video",
    document: "document",
    sticker: "sticker",
    location: "location",
    contacts: "contacts",
    interactive: "interactive",
    button: "button",
    reaction: "reaction",
  };
  return map[type] ?? "unknown";
}

function extractContent(msg: MetaMessage & Record<string, unknown>): unknown {
  // Return the relevant content block for the message type
  const type = msg.type as string;
  if (type === "text") return msg.text;
  if (type === "image") return msg.image;
  if (type === "audio") return msg.audio;
  if (type === "video") return msg.video;
  if (type === "document") return msg.document;
  if (type === "sticker") return msg.sticker;
  if (type === "location") return msg.location;
  if (type === "contacts") return msg.contacts;
  if (type === "interactive") return msg.interactive;
  if (type === "button") return msg.button;
  if (type === "reaction") return msg.reaction;
  return { raw: msg };
}
