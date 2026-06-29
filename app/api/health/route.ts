import { NextResponse } from "next/server";

// Liveness/readiness probe target. Deliberately does NOT touch the DB or any
// external service (OpenAI/Notion/Drive) so a transient upstream outage can't
// flap the pod — the container is "healthy" as long as the server answers.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
