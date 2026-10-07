/**
 * Public interface types shared across all WhatsApp providers.
 * Meta-specific payload shapes live in ./meta/payload-types.ts only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Outbound message building blocks
// ─────────────────────────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  body: string;
  previewUrl?: boolean;
}

export interface TemplateContent {
  type: "template";
  name: string;
  language: { code: string };
  components?: TemplateComponent[];
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "quick_reply" | "url";
  index?: number;
  parameters: TemplateParameter[];
}

export type TemplateParameter =
  | { type: "text"; text: string }
  | { type: "currency"; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: "date_time"; date_time: { fallback_value: string } }
  | { type: "image"; image: MediaObject }
  | { type: "document"; document: MediaObject }
  | { type: "video"; video: MediaObject }
  | { type: "payload"; payload: string };

export interface MediaObject {
  id?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

export interface InteractiveContent {
  type: "interactive";
  interactive:
    | InteractiveButton
    | InteractiveList
    | InteractiveProduct
    | InteractiveProductList;
}

export interface InteractiveButton {
  type: "button";
  body: { text: string };
  header?: { type: "text"; text: string } | { type: "image"; image: MediaObject };
  footer?: { text: string };
  action: {
    buttons: Array<{
      type: "reply";
      reply: { id: string; title: string };
    }>;
  };
}

export interface InteractiveList {
  type: "list";
  body: { text: string };
  header?: { type: "text"; text: string };
  footer?: { text: string };
  action: {
    button: string;
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
  };
}

export interface InteractiveProduct {
  type: "product";
  body?: { text: string };
  footer?: { text: string };
  action: { catalog_id: string; product_retailer_id: string };
}

export interface InteractiveProductList {
  type: "product_list";
  header: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  action: {
    catalog_id: string;
    sections: Array<{
      title: string;
      product_items: Array<{ product_retailer_id: string }>;
    }>;
  };
}

export type OutboundContent =
  | TextContent
  | TemplateContent
  | InteractiveContent;

// ─────────────────────────────────────────────────────────────────────────────
// Internal normalised events (what the worker receives)
// ─────────────────────────────────────────────────────────────────────────────

export interface InternalInboundMessage {
  kind: "message";
  providerEventId: string; // unique per event for idempotency
  providerId: string;      // wamid — WA message id
  fromPhone: string;       // E.164
  toPhone: string;         // E.164 (our number)
  timestamp: Date;
  contentType: InboundContentType;
  content: unknown;        // raw content block, stored as-is in DB
}

export type InboundContentType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "unknown";

export interface InternalStatusUpdate {
  kind: "status";
  providerEventId: string;
  providerId: string;  // wamid of the message whose status changed
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
  recipientPhone: string;
  errorCode?: string;
  errorTitle?: string;
}

export type ParsedWebhookEvent = InternalInboundMessage | InternalStatusUpdate;

// ─────────────────────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────────────────────

export interface SendResult {
  providerId: string; // wamid returned by provider
}

export interface WebhookVerification {
  valid: boolean;
  challenge?: string; // returned for GET hub.challenge
}

export interface WhatsAppProvider {
  /**
   * Send a plain-text message.
   */
  sendText(to: string, body: string): Promise<SendResult>;

  /**
   * Send an approved template message.
   * Templates can be sent outside the 24-hour service window.
   */
  sendTemplate(to: string, template: TemplateContent): Promise<SendResult>;

  /**
   * Send an interactive message (buttons or list).
   * Only valid inside the 24-hour service window.
   */
  sendInteractive(to: string, interactive: InteractiveContent): Promise<SendResult>;

  /**
   * Verify a META webhook GET challenge or POST signature.
   * For GET: returns { valid, challenge } to echo back.
   * For POST: returns { valid } — caller should reject if !valid.
   */
  verifyWebhook(params: {
    mode?: string;
    token?: string;
    challenge?: string;
    signature?: string;
    rawBody?: string;
  }): Promise<WebhookVerification>;

  /**
   * Parse a raw webhook POST body (already verified) into internal events.
   */
  parseWebhook(rawBody: string): Promise<ParsedWebhookEvent[]>;

  /**
   * Download media by its provider media ID.
   * Returns the binary buffer and MIME type.
   */
  downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ServiceWindowError extends ProviderError {
  constructor(message = "Outside 24-hour service window: only templates allowed") {
    super(message, "SERVICE_WINDOW_CLOSED", false);
    this.name = "ServiceWindowError";
  }
}
