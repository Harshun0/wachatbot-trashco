/**
 * WhatsApp "magic link" login for sellers/buyers — no password.
 * The bot sends this URL; opening it redeems a short-lived signed token into
 * a normal dashboard session cookie (see /dashboard/magic/route.ts).
 */
import { env } from "./env";
import { createToken, verifyToken, type SessionRole } from "./session";

const MAGIC_LINK_TTL_SECONDS = 15 * 60; // 15 minutes — single use, redeemed immediately

export function buildMagicLink(partyId: string, role: Extract<SessionRole, "SELLER" | "BUYER" | "BOTH">): string {
  const token = createToken({ role, partyId }, MAGIC_LINK_TTL_SECONDS);
  const url = new URL("/dashboard/magic", env.APP_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

export function verifyMagicLink(token: string): { partyId: string; role: SessionRole } | null {
  const payload = verifyToken(token);
  if (!payload || !payload.partyId) return null;
  return { partyId: payload.partyId, role: payload.role };
}
