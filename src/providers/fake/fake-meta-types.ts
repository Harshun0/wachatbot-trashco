/**
 * Subset of Meta payload types used by FakeProvider.
 * These mirror the real Meta shapes so the FakeProvider emits
 * structurally identical payloads.
 */

export interface MetaWebhookPayload {
  object: "whatsapp_business_account";
  entry: MetaEntry[];
}

export interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

export interface MetaChange {
  field: "messages";
  value: MetaChangeValue;
}

export interface MetaChangeValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

export interface MetaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text: string; payload: string };
}

export interface MetaStatus {
  id: string;
  recipient_id: string;
  status: "sent" | "delivered" | "read" | "failed" | "deleted" | "warning";
  timestamp: string;
  errors?: Array<{ code: number; title: string }>;
}
