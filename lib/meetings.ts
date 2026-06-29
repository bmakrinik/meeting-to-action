import { db } from "./db";

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
  startedAt: string;
  finishedAt: string | null;
  actionItems: ActionItemRow[];
}

// Run history, newest first, with action items joined in.
export function listMeetings(limit = 100): MeetingRow[] {
  const runs = db()
    .prepare(
      `SELECT id, file_id, file_name, status, error, summary, transcript, raw_transcript,
              notion_url, meeting_time, attendees, unmapped_speakers, transcribe_model,
              postprocess_model, started_at, finished_at
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
    attendees: r.attendees ? JSON.parse(r.attendees) : [],
    unmappedSpeakers: r.unmapped_speakers ? JSON.parse(r.unmapped_speakers) : [],
    transcribeModel: r.transcribe_model,
    postprocessModel: r.postprocess_model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    actionItems: itemStmt.all(r.id) as ActionItemRow[],
  }));
}
