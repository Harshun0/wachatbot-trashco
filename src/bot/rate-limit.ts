/**
 * Per-party LLM rate limiter — fixed 60s window counter in Redis.
 * Keeps a chatty user from triggering unbounded Gemini calls (cost control).
 */
import { redis } from "@/lib/redis";
import { env } from "@/lib/env";

const WINDOW_SECONDS = 60;

/** Returns true if the party is still under the per-minute LLM call limit. */
export async function allowLLMCall(partyId: string): Promise<boolean> {
  const key = `llm_rate:${partyId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }
  return count <= env.LLM_MAX_PER_MINUTE;
}
