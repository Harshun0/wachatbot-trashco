/**
 * GET /api/admin/listings
 *
 * Lists all Listing records for the organization.
 * Protected by INTERNAL_API_KEY header (same key as /api/admin/parties).
 *
 * Query params:
 *   status=DRAFT|OPEN|CLOSED   — filter by status
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
  status: z.enum(["DRAFT", "OPEN", "CLOSED"]).optional(),
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
  const { status, page } = qp.data;

  const org = await prisma.organization.findFirst({ select: { id: true } });
  if (!org) {
    return Response.json({ data: [], total: 0, page, pageSize: PAGE_SIZE });
  }

  const where = {
    organizationId: org.id,
    ...(status ? { status } : {}),
  };

  const [total, listings] = await Promise.all([
    prisma.listing.count({ where }),
    prisma.listing.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        sellerParty: { select: { name: true, city: true, contact: { select: { waPhone: true } } } },
        media: { select: { id: true, storageUrl: true, mimeType: true } },
      },
    }),
  ]);

  return Response.json({
    data: listings,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
