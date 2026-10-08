/**
 * Centralised environment variable validation with Zod.
 * Import `env` everywhere instead of accessing `process.env` directly.
 * Fails fast at startup if any required variable is missing or invalid.
 */
import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Redis
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // WhatsApp provider selection
  WA_PROVIDER: z.enum(["fake", "meta"]).default("fake"),

  // Meta Cloud API (required when WA_PROVIDER=meta, placeholders accepted for fake)
  WA_PHONE_NUMBER_ID: z.string().min(1, "WA_PHONE_NUMBER_ID is required"),
  WA_WABA_ID: z.string().min(1, "WA_WABA_ID is required"),
  WA_ACCESS_TOKEN: z.string().min(1, "WA_ACCESS_TOKEN is required"),
  WA_APP_SECRET: z.string().min(1, "WA_APP_SECRET is required"),
  WA_VERIFY_TOKEN: z.string().min(1, "WA_VERIFY_TOKEN is required"),

  // Internal service-to-service API key — protects /api/messages/send
  // Generate with: openssl rand -hex 32
  INTERNAL_API_KEY: z.string().min(16, "INTERNAL_API_KEY must be at least 16 chars"),

  // Meta Graph API version — default v21.0, set to match your app dashboard
  WA_GRAPH_VERSION: z.string().default("v21.0"),

  // LLM provider — "gemini" | "claude" (future). Default gemini.
  LLM_PROVIDER: z.enum(["gemini", "claude"]).default("gemini"),
  // Gemini API key (required when LLM_PROVIDER=gemini)
  GEMINI_API_KEY: z.string().optional(),
  // Claude API key (required when LLM_PROVIDER=claude)
  CLAUDE_API_KEY: z.string().optional(),
  // LLM model override — defaults chosen per provider if not set
  LLM_MODEL: z.string().optional(),
  // Max LLM calls per party per minute — avoids cost spikes from one chatty user
  LLM_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(10),

  // Runtime
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

// Parse once; throws with clear field-level errors on failure.
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error(
    "❌ Invalid environment variables:\n",
    _env.error.flatten().fieldErrors
  );
  throw new Error("Invalid environment variables. Check server logs.");
}

export const env = _env.data;
export type Env = typeof env;
