/**
 * Listing/requirement intent extractor.
 *
 * Code decides every state transition (seller/buyer flow) — this module only
 * pulls structured fields out of a free-text WhatsApp message (often Hinglish).
 * Never invents values: anything not present in the message stays null.
 *
 * On invalid JSON, schema mismatch, or LLM failure: returns null. Callers
 * must fall back to a fixed "please rephrase" reply — never crash.
 */
import { z } from "zod";
import { callLLM } from "./llm";

export const extractedIntentSchema = z.object({
  intent: z.enum([
    "create_listing",
    "add_details",
    "create_requirement",
    "close_listing",
    "other",
  ]),
  product: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  quantity: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  location: z.string().nullable().default(null),
  listingCode: z.string().nullable().default(null),
  missing: z.array(z.string()).default([]),
});

export type ExtractedIntent = z.infer<typeof extractedIntentSchema>;

export interface DraftState {
  product?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit?: string | null;
  price?: number | null;
  location?: string | null;
}

export interface ExtractorInput {
  text: string;
  role: "SELLER" | "BUYER";
  /** The seller's open DRAFT listing or buyer's in-progress requirement, if any. */
  draft?: DraftState | null;
  /** Last ~6 messages of the conversation, oldest first, plain text. */
  recentMessages?: string[];
}

const SYSTEM_PROMPT = `You are a data extraction engine for a WhatsApp marketplace bot used by Indian commodity traders. Users write in Hinglish (Hindi written in Latin script mixed with English), e.g. "100 ton cement bags sell karna hai" or "mujhe 50 ton cement chahiye Pune me".

Extract structured fields from the user's latest message. Use the conversation context and the current draft only to understand what is already known — do NOT repeat already-known values unless the user is correcting them.

Return ONLY JSON matching this exact shape, no prose, no markdown fences:
{
  "intent": "create_listing" | "add_details" | "create_requirement" | "close_listing" | "other",
  "product": string | null,
  "category": string | null,
  "quantity": number | null,
  "unit": string | null,
  "price": number | null,
  "location": string | null,
  "listingCode": string | null,
  "missing": string[]
}

Rules:
- "create_listing": seller describing a new product to sell (first mention of a product).
- "add_details": seller or buyer adding quantity/price/location/etc to an existing draft.
- "create_requirement": buyer describing something they want to buy.
- "close_listing": user says things like "close LST-0001", "sold", "band karo" — extract listingCode if present.
- "other": greetings, menu requests, anything that isn't listing/requirement related.
- Never invent a value. If a field isn't mentioned in this message, set it to null.
- "price" means price per unit, extract only the number (no currency symbols).
- "quantity" is a plain number (convert words like "sau" = 100 if unambiguous, otherwise null).
- "missing" lists field names (from: quantity, unit, price, location) that are still needed to complete a listing/requirement, given the draft context provided.`;

function buildUserPrompt(input: ExtractorInput): string {
  const parts: string[] = [];
  parts.push(`Role: ${input.role}`);
  if (input.draft) {
    parts.push(`Current draft: ${JSON.stringify(input.draft)}`);
  }
  if (input.recentMessages && input.recentMessages.length > 0) {
    parts.push(`Recent conversation:\n${input.recentMessages.join("\n")}`);
  }
  parts.push(`Latest message: ${input.text}`);
  return parts.join("\n\n");
}

/**
 * Extract intent + fields from a user's message.
 * Returns null on any failure — caller must reply with a fixed rephrase prompt.
 */
export async function extractIntent(input: ExtractorInput): Promise<ExtractedIntent | null> {
  return callLLM<ExtractedIntent>({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
    schema: extractedIntentSchema,
  });
}
