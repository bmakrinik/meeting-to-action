import { NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { restartScheduler } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PUT(req: Request) {
  const body = await req.json();
  const saved = saveSettings(body);
  // Apply cadence / enabled changes immediately.
  restartScheduler();
  return NextResponse.json(saved);
}
