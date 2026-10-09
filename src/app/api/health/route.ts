/**
 * GET /api/health
 * Plain liveness check for uptime monitors (e.g. UptimeRobot) — no auth,
 * no DB/Redis calls, just confirms the Next.js server is up and responding.
 */
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ status: "ok", time: new Date().toISOString() });
}
