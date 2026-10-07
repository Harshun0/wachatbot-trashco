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
