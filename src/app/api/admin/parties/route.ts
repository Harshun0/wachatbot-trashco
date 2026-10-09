/**
 * GET /api/admin/parties
 *
 * Lists all Party records for the organization.
 * Protected by INTERNAL_API_KEY header (same key as /api/messages/send).
 *
 * Query params:
 *   role=BUYER|SELLER|BOTH     — filter by role
 *   step=ASK_ROLE|...DONE      — filter by onboarding step
 *   page=1                     — 1-indexed page (25 per page)
 */
import { type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const PAGE_SIZE = 25;

const querySchema = z.object({
  role: z.enum(["BUYER", "SELLER", "BOTH"]).optional(),
  step: z
    .enum(["ASK_ROLE", "ASK_NAME", "ASK_CITY", "ASK_ALERTS", "DONE"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
});

function checkApiKey(req: NextRequest): boolean {
  const provided = req.headers.get("x-internal-api-key") ?? "";
  const expected = env.INTERNAL_API_KEY;
  try {
    return (
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = Object.fromEntries(request.nextUrl.searchParams);
  const qp = querySchema.safeParse(raw);
  if (!qp.success) {
    return Response.json(
      { error: "Invalid query params", details: qp.error.flatten() },
      { status: 422 }
    );
  }
  const { role, step, page } = qp.data;

  // Resolve org (pilot: first org)
  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) {
    return Response.json({ data: [], total: 0, page, pageSize: PAGE_SIZE });
  }

  const where = {
    organizationId: org.id,
    ...(role ? { role } : {}),
    ...(step ? { onboardingStep: step } : {}),
  };

  const [total, parties] = await Promise.all([
    prisma.party.count({ where }),
    prisma.party.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        contact: { select: { waPhone: true, optInScope: true } },
      },
    }),
  ]);

  return Response.json({
    data: parties,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
