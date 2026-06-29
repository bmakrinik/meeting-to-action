import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";
import { recentPolls } from "@/lib/poll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Poller health: whether auto-poll is on, the cadence, and recent poll outcomes.
export async function GET() {
  const s = getSettings();
  return NextResponse.json({
    cronEnabled: s.cronEnabled,
    pollIntervalMinutes: s.pollIntervalMinutes,
    polls: recentPolls(15),
  });
}
