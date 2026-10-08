/**
 * Dashboard session tokens — signed, stateless, no extra dependency.
 *
 * Format: base64url(payload-json) + "." + hmac-sha256(payload, SESSION_SECRET)
 * Used both for the session cookie and (with a short exp + purpose: "magic")
 * for the one-time WhatsApp magic link — see magic-link.ts.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

export const SESSION_COOKIE = "wacrm_session";

export type SessionRole = "ADMIN" | "AGENT" | "SELLER" | "BUYER";

export interface SessionPayload {
  role: SessionRole;
  userId?: string;   // set for ADMIN/AGENT
  partyId?: string;  // set for SELLER/BUYER
  exp: number;       // unix seconds
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = createHmac("sha256", env.SESSION_SECRET).update(body).digest("base64url");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null; // length mismatch etc.
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createToken(payload: Omit<SessionPayload, "exp">, maxAgeSeconds: number): string {
  return sign({ ...payload, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds });
}
