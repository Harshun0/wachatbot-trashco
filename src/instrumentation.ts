/**
 * Next.js instrumentation hook — runs once when the server starts.
 * In production this starts the BullMQ workers in the same process as Next.js,
 * avoiding the need for a separate worker dyno/service.
 *
 * Docs: https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  // Only run in Node.js runtime (not Edge), and only on the server
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Only start workers if Redis is configured
  if (!process.env.REDIS_URL || process.env.REDIS_URL.includes("localhost")) return;

  console.info("[Instrumentation] Starting BullMQ workers...");

  try {
    // Dynamic import so the worker module (and its Redis connection)
    // is only loaded when actually needed
    await import("./queues/worker");
    console.info("[Instrumentation] BullMQ workers started ✅");
  } catch (err) {
    console.error("[Instrumentation] Failed to start workers:", err);
  }
}
