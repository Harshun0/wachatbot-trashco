/**
 * GET /dashboard/magic?token=...
 * Redeems a WhatsApp magic-link token (see src/lib/magic-link.ts) into a
 * normal dashboard session cookie, then redirects into the dashboard.
 */
import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyMagicLink } from "@/lib/magic-link";
import { createToken, SESSION_COOKIE } from "@/lib/session";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const redeemed = token ? verifyMagicLink(token) : null;

  // Build redirects from APP_URL, not request.url — behind Render's proxy,
  // request.url resolves to the internal localhost:10000 address, not the
  // public hostname.
  if (!redeemed) {
    return NextResponse.redirect(new URL("/dashboard/expired", env.APP_URL));
  }

  const session = createToken({ role: redeemed.role, partyId: redeemed.partyId }, SESSION_TTL_SECONDS);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return NextResponse.redirect(new URL("/dashboard", env.APP_URL));
}
