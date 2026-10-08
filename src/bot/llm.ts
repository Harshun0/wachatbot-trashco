/**
 * LLM abstraction layer.
 *
 * Current provider: Gemini (gemini-2.0-flash)
 * Future provider:  Claude (switch via LLM_PROVIDER=claude env var)
 *
 * Rules:
 * - Always request JSON output; validate with Zod.
 * - On API error, timeout, or invalid JSON → return null (caller uses fallback).
 * - Never throw from this module — the bot must never crash because of LLM.
 * - Never log prompt contents that contain user phone numbers or PII at info level.
 */
import { env } from "@/lib/env";
import { z } from "zod";

// ─── Shared interface ─────────────────────────────────────────────────────────

export interface LLMRequest {
  /** System instruction */
  system: string;
  /** User turn */
  user: string;
  /** Zod schema to validate the JSON response */
  schema: z.ZodTypeAny;
  /** Timeout in ms (default 8000) */
  timeoutMs?: number;
}

/**
 * Call the configured LLM and return parsed + validated JSON.
 * Returns null on any error so callers can fall back to a fixed question.
 */
export async function callLLM<T>(req: LLMRequest): Promise<T | null> {
  try {
    const provider = env.LLM_PROVIDER ?? "gemini";
    if (provider === "gemini") {
      return await callGemini<T>(req);
    }
    // Claude path — stubbed, will be filled when switching
    return await callClaude<T>(req);
  } catch (err) {
    console.error("[LLM] Unexpected error:", (err as Error).message);
    return null;
  }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini<T>(req: LLMRequest): Promise<T | null> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[LLM] GEMINI_API_KEY not set, skipping LLM call");
    return null;
  }

  const model = env.LLM_MODEL ?? "gemini-2.0-flash";
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json" },
    systemInstruction: req.system,
  });

  const timeoutMs = req.timeoutMs ?? 8000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const result = await geminiModel.generateContent(req.user);
    const text = result.response.text().trim();
    return parseAndValidate<T>(text, req.schema);
  } catch (err) {
    console.error("[LLM/Gemini] Call failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Claude stub ─────────────────────────────────────────────────────────────

async function callClaude<T>(req: LLMRequest): Promise<T | null> {
  const apiKey = env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.warn("[LLM] CLAUDE_API_KEY not set, skipping LLM call");
    return null;
  }
  // TODO: implement when switching — use @anthropic-ai/sdk
  // Model default: env.LLM_MODEL ?? "claude-3-5-haiku-20241022"
  console.warn("[LLM] Claude provider not yet implemented");
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAndValidate<T>(text: string, schema: z.ZodTypeAny): T | null {
  try {
    // Gemini sometimes wraps JSON in markdown fences
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      console.warn("[LLM] Schema validation failed:", result.error.flatten());
      return null;
    }
    return result.data as T;
  } catch {
    console.warn("[LLM] JSON parse failed for response:", text.slice(0, 100));
    return null;
  }
}
