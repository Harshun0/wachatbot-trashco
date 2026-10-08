/**
 * Route protection for /dashboard/**.
 *
 * Named `proxy.ts` (not `middleware.ts`) — Next.js 16 renamed the file
 * convention; functionality is the same. Defaults to the Node.js runtime,
 * so the session verification (Node `crypto`) works here without changes.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyToken, SESSION_COOKIE } from "@/lib/session";
import { env } from "@/lib/env";

const PUBLIC_PATHS = ["/dashboard/login", "/dashboard/magic", "/dashboard/expired"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? verifyToken(token) : null;

  if (!session) {
    // Build from APP_URL, not request.url — behind Render's proxy, request.url
    // resolves to the internal localhost:10000 address, not the public host.
    return NextResponse.redirect(new URL("/dashboard/login", env.APP_URL));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
