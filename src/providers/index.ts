/**
 * Provider factory — returns the correct WhatsAppProvider based on WA_PROVIDER env var.
 * Import `getProvider()` anywhere you need to send or parse WhatsApp events.
 */
import { env } from "@/lib/env";
import type { WhatsAppProvider } from "./types";

let _provider: WhatsAppProvider | null = null;

export function getProvider(): WhatsAppProvider {
  if (_provider) return _provider;

  if (env.WA_PROVIDER === "meta") {
    const { MetaCloudProvider } = require("./meta") as typeof import("./meta");
    _provider = new MetaCloudProvider({
      phoneNumberId: env.WA_PHONE_NUMBER_ID,
      accessToken: env.WA_ACCESS_TOKEN,
      appSecret: env.WA_APP_SECRET,
      verifyToken: env.WA_VERIFY_TOKEN,
    });
  } else {
    const { FakeProvider } = require("./fake") as typeof import("./fake");
    _provider = new FakeProvider({
      verifyToken: env.WA_VERIFY_TOKEN,
      appSecret: env.WA_APP_SECRET,
      ourPhone: `+${env.WA_PHONE_NUMBER_ID}`,
    });
  }

  return _provider;
}

/** Reset the cached provider (useful in tests). */
export function resetProvider(): void {
  _provider = null;
}

export type { WhatsAppProvider };
export * from "./types";
