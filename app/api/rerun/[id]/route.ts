import { NextResponse } from "next/server";
import { rerunByRunId } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const runId = Number(params.id);
  if (!Number.isFinite(runId)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  try {
    const result = await rerunByRunId(runId);
    if (!result) {
      return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
