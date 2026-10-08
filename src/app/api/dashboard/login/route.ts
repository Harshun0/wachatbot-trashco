/**
 * POST /api/dashboard/login
 * Admin/agent email+password login. Sellers/buyers never use this — they
 * log in via the WhatsApp magic link (see /dashboard/magic/route.ts).
 */
import { type NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import { createToken, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const token = createToken({ role: user.role, userId: user.id }, SESSION_TTL_SECONDS);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return NextResponse.json({ ok: true, role: user.role });
}
