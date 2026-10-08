/**
 * Server-side session helper for dashboard pages/layouts (Server Components
 * and Route Handlers only — reads the httpOnly cookie via next/headers).
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyToken, SESSION_COOKIE, type SessionPayload } from "./session";

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export function isAdmin(session: SessionPayload | null): boolean {
  return session?.role === "ADMIN" || session?.role === "AGENT";
}

/** Use at the top of a page/server component — proxy.ts already redirects
 * unauthenticated requests, this is a defensive second check. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  return session;
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireSession();
  if (!isAdmin(session)) redirect("/dashboard");
  return session;
}
