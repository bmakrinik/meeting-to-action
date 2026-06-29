import { NextResponse } from "next/server";
import { listMeetings } from "@/lib/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listMeetings());
}
