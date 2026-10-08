/**
 * Per-party rate limiters — fixed-window counters in Redis.
 *  - allowLLMCall: keeps a chatty user from triggering unbounded Gemini calls.
 *  - allowAlert: caps proactive match-alert messages per party per day.
 */
import { redis } from "@/lib/redis";
import { env } from "@/lib/env";

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * 60;

/** Returns true if the party is still under the per-minute LLM call limit. */
export async function allowLLMCall(partyId: string): Promise<boolean> {
  const key = `llm_rate:${partyId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, MINUTE_SECONDS);
  }
  return count <= env.LLM_MAX_PER_MINUTE;
}

/** Returns true if the party is still under the per-day match-alert limit. */
export async function allowAlert(partyId: string): Promise<boolean> {
  const key = `alert_rate:${partyId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, DAY_SECONDS);
  }
  return count <= env.ALERT_MAX_PER_DAY;
}
