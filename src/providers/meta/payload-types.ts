/**
 * Raw Meta Cloud API webhook payload shapes.
 * These types MUST NOT be imported outside src/providers/meta/.
 * Convert to internal types (ParsedWebhookEvent) before exporting.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inbound webhook payload
// ─────────────────────────────────────────────────────────────────────────────

export interface MetaWebhookPayload {
  object: "whatsapp_business_account";
  entry: MetaEntry[];
}

export interface MetaEntry {
  id: string; // WABA id
  changes: MetaChange[];
}

export interface MetaChange {
  value: MetaChangeValue;
  field: "messages";
}

export interface MetaChangeValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  errors?: MetaError[];
}

export interface MetaContact {
  profile: { name: string };
  wa_id: string;
}

export interface MetaMessage {
  id: string;              // wamid
  from: string;            // sender phone (E.164 without +)
  timestamp: string;       // unix epoch string
  type: MetaMessageType;
  text?: { body: string };
  image?: MetaMediaMessage;
  audio?: MetaMediaMessage;
  video?: MetaMediaMessage;
  document?: MetaMediaMessage & { filename?: string };
  sticker?: MetaMediaMessage;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  contacts?: MetaContactsMessage[];
  interactive?: MetaInteractiveMessage;
  button?: { text: string; payload: string };
  reaction?: { message_id: string; emoji: string };
  referral?: {
    source_url: string;
    source_id: string;
    source_type: string;
    headline: string;
    body: string;
    media_type: string;
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
  };
  errors?: MetaError[];
  context?: {
    forwarded?: boolean;
    frequently_forwarded?: boolean;
    from?: string;
    id?: string;
  };
}

export type MetaMessageType =
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
  | "unsupported"
  | "order"
  | "system";

export interface MetaMediaMessage {
  id: string;
  mime_type: string;
  sha256: string;
  caption?: string;
}

export interface MetaContactsMessage {
  name: { formatted_name: string };
  phones?: Array<{ phone: string; type?: string }>;
}

export interface MetaInteractiveMessage {
  type: "button_reply" | "list_reply" | "nfm_reply";
  button_reply?: { id: string; title: string };
  list_reply?: { id: string; title: string; description?: string };
}

export interface MetaStatus {
  id: string;           // wamid of the message
  recipient_id: string; // phone number of the recipient
  status: "sent" | "delivered" | "read" | "failed" | "deleted" | "warning";
  timestamp: string;    // unix epoch string
  conversation?: {
    id: string;
    expiration_timestamp?: string;
    origin: { type: string };
  };
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string;
  };
  errors?: MetaError[];
}

export interface MetaError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound API response
// ─────────────────────────────────────────────────────────────────────────────

export interface MetaSendResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

export interface MetaMediaUrlResponse {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
  messaging_product: "whatsapp";
}

export interface MetaErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    error_data?: { messaging_product: string; details: string };
    error_subcode?: number;
    fbtrace_id?: string;
  };
}
