/**
 * IORedis singleton for BullMQ.
 * Upstash Redis uses TLS — the rediss:// protocol handles that automatically.
 */
import IORedis from "ioredis";
import { env } from "./env";

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

function createRedis(): IORedis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    tls: env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  client.on("error", (err) => {
    console.error("[Redis] Connection error:", err.message);
  });

  return client;
}

export const redis = globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
