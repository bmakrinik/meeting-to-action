import { NextResponse } from "next/server";
import { runPoll } from "@/lib/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow long-running transcription work.
export const maxDuration = 600;

// Manual "Run now": process all new files immediately, recording the poll for visibility.
export async function POST() {
  const { poll, results } = await runPoll("manual");
  return NextResponse.json({ ok: !poll.error, poll, results });
}
