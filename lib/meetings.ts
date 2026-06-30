import { db } from "./db";
import type { CostBreakdown } from "./pricing";

export interface ActionItemRow {
  owner: string | null;
  task: string;
  due: string | null;
  evidence: string | null;
}

export interface MeetingRow {
  id: number;
  fileId: string;
  fileName: string;
  status: string;
  error: string | null;
  summary: string | null;
  transcript: string | null;
  rawTranscript: string | null;
  notionUrl: string | null;
  meetingTime: string | null;
  attendees: string[];
  unmappedSpeakers: string[];
  transcribeModel: string | null;
  postprocessModel: string | null;
  cleanModel: string | null;
  audioSeconds: number | null;
  totalCostUsd: number | null;
  cost: CostBreakdown | null;
  startedAt: string;
  finishedAt: string | null;
  actionItems: ActionItemRow[];
}

// Parse a JSON column without letting one corrupt/partial row take down the whole list.
function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Run history, newest first, with action items joined in.
export function listMeetings(limit = 100): MeetingRow[] {
  const runs = db()
    .prepare(
      `SELECT id, file_id, file_name, status, error, summary, transcript, raw_transcript,
              notion_url, meeting_time, attendees, unmapped_speakers, transcribe_model,
              postprocess_model, clean_model, audio_seconds, total_cost_usd, cost_json,
              started_at, finished_at
       FROM runs ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as any[];

  const itemStmt = db().prepare(
    `SELECT owner, task, due, evidence FROM action_items WHERE run_id = ?`
  );

  return runs.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    fileName: r.file_name,
    status: r.status,
    error: r.error,
    summary: r.summary,
    transcript: r.transcript,
    rawTranscript: r.raw_transcript,
    notionUrl: r.notion_url,
    meetingTime: r.meeting_time ?? null,
    attendees: safeParse<string[]>(r.attendees, []),
    unmappedSpeakers: safeParse<string[]>(r.unmapped_speakers, []),
    transcribeModel: r.transcribe_model,
    postprocessModel: r.postprocess_model,
    cleanModel: r.clean_model ?? null,
    audioSeconds: r.audio_seconds ?? null,
    totalCostUsd: r.total_cost_usd ?? null,
    cost: safeParse<CostBreakdown | null>(r.cost_json, null),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    actionItems: itemStmt.all(r.id) as ActionItemRow[],
  }));
}
