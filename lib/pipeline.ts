import { db } from "./db";
import { getSettings, recordingsFolderIds } from "./settings";
import * as drive from "./drive";
import * as audio from "./audio";
import * as transcribe from "./transcribe";
import * as postprocess from "./postprocess";
import * as notion from "./notion";
import type { MeetingFile } from "./drive";

export interface RunSummary {
  fileId: string;
  fileName: string;
  status: "success" | "failed" | "transcribed" | "duplicate";
  error?: string;
  notionUrl?: string;
}

// Identity of a meeting, derived from the recording's name. Meet names include the
// meeting title and timestamp, so two copies of the same meeting share this key while
// different meetings (and recurring ones, which differ by timestamp) do not.
function meetingKeyOf(name: string): string {
  return name
    .replace(/\.(mp4|m4a)$/i, "")
    .replace(/\s*-\s*recording\s*$/i, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Process a single meeting file end to end. Idempotent: on success the file id is
// recorded and the source MP4 trashed; on failure nothing is marked, so the next
// cron cycle (or a manual re-run) retries it.
export async function processFile(file: MeetingFile): Promise<RunSummary> {
  const settings = getSettings();
  const startedAt = new Date().toISOString();
  const meetingKey = meetingKeyOf(file.name);

  const runId = (
    db()
      .prepare(
        `INSERT INTO runs (file_id, file_name, meeting_key, status, transcribe_model, postprocess_model, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(
        file.id,
        file.name,
        meetingKey,
        settings.transcribeModel,
        settings.postprocessModel,
        startedAt
      ).lastInsertRowid as number
  );

  // Dedup: if another file (different id) already produced a successful run for the same
  // meeting, skip this copy rather than transcribe it again. Files are processed
  // sequentially within a poll, so the first copy's success is recorded before the next starts.
  const dup = db()
    .prepare(
      `SELECT notion_url FROM runs WHERE meeting_key = ? AND status = 'success' AND file_id != ? LIMIT 1`
    )
    .get(meetingKey, file.id) as { notion_url: string | null } | undefined;
  if (dup) {
    db()
      .prepare(`UPDATE runs SET status='duplicate', error=?, finished_at=? WHERE id=?`)
      .run(
        "Duplicate of an already-processed meeting; skipped.",
        new Date().toISOString(),
        runId
      );
    drive.markProcessed(file);
    if (file.source === "drive") {
      try {
        await drive.trash(file); // remove the redundant copy to keep the folder clean
      } catch {
        /* best-effort */
      }
    }
    return { fileId: file.id, fileName: file.name, status: "duplicate" };
  }

  let audioChunks: string[] = [];
  try {
    const dbId = settings.notionDatabaseId || process.env.NOTION_DATABASE_ID;

    // Meeting time (~ when it happened): the recording's createdTime, not now.
    const meetingTime = (await drive.meetingTime(file)) || null;

    const mp4Path = await drive.download(file);
    // The diarize model is much slower, so use small (5-min) chunks to stay under the
    // API client timeout; the plain model handles 20-min chunks comfortably.
    const isDiarize = /diarize/i.test(settings.transcribeModel);
    const extracted = await audio.extract(mp4Path, file.id, isDiarize ? 300 : 1200);
    audioChunks = extracted.chunks;

    const t = await transcribe.run(audioChunks, settings);
    const pp = await postprocess.run(t.text, settings);

    // Prefer authoritative calendar data (stamped on the file by the mover script) over
    // the LLM's inference. Attendees = actual/accepted guests if known, else invited, else
    // the inferred list. Host = the event organizer if known, else the inferred host.
    const cal = file.calendar;
    const attendees =
      cal?.attendees?.length ? cal.attendees : cal?.invited?.length ? cal.invited : pp.attendees;
    const host = cal?.organizer || pp.host;
    const invited = cal?.invited || [];

    // Persist transcription + extraction results immediately, BEFORE the Notion write,
    // so they survive on the dashboard even if routing is skipped or fails.
    db()
      .prepare(
        `UPDATE runs SET transcript=?, raw_transcript=?, summary=?, unmapped_speakers=?,
           meeting_time=?, attendees=? WHERE id=?`
      )
      .run(
        pp.cleanedTranscript,
        pp.rawTranscript,
        pp.summary,
        JSON.stringify(pp.unmappedSpeakers),
        meetingTime,
        JSON.stringify(attendees),
        runId
      );

    const insertItem = db().prepare(
      `INSERT INTO action_items (run_id, owner, task, due, evidence) VALUES (?, ?, ?, ?, ?)`
    );
    for (const a of pp.actionItems) {
      insertItem.run(runId, a.owner, a.task, a.due, a.evidence);
    }

    // Routing step. Notion is optional: if a token + database id are present we write a
    // page and mark the file fully done; otherwise the run is "transcribed" (results are
    // saved and visible) and the file is left unprocessed so it routes once Notion is set up.
    const notionConfigured = !!(process.env.NOTION_TOKEN && dbId);

    if (notionConfigured) {
      // Clean meeting title: drop ".mp4", a trailing " - Recording", and the trailing
      // date/time/timezone (Meet appends it; it's already captured in Date & Time).
      // "Google Ads - SEO - 2026/06/29 14:00 EEST - Recording.mp4" -> "Google Ads - SEO"
      let title = file.name
        .replace(/\.mp4$/i, "")
        .replace(/\s*-\s*recording\s*$/i, "")
        .replace(
          /\s*[-–]\s*\d{4}[/_.-]\d{2}[/_.-]\d{2}[ T_]+\d{2}[:_.]\d{2}(?:[:_.]\d{2})?(?:\s*[A-Za-z]{2,5})?\s*$/,
          ""
        )
        .trim();
      if (!title) title = (meetingTime || startedAt).slice(0, 10); // fallback if name was only a date
      const page = await notion.write({
        databaseId: dbId!,
        title,
        meetingTime,
        attendees,
        host,
        invited,
        summary: pp.summary,
        actionItems: pp.actionItems,
        transcript: pp.cleanedTranscript,
        unmappedSpeakers: pp.unmappedSpeakers,
      });

      db()
        .prepare(
          `UPDATE runs SET status='success', notion_url=?, finished_at=? WHERE id=?`
        )
        .run(page.url, new Date().toISOString(), runId);

      // Only now is the data safely landed: mark done.
      drive.markProcessed(file);

      // Retain a small audio copy in the Shared Drive so the video can be removed later
      // (immediately if configured, otherwise by the retention sweep after N days).
      // Best-effort: failure here must not fail an already-published run.
      if (file.source === "drive") {
        const recFolder = file.folderId || recordingsFolderIds()[0];
        if (recFolder) {
          try {
            const audioName = `${file.name.replace(/\.mp4$/i, "")}.m4a`;
            if (!(await drive.fileExistsInFolder(recFolder, audioName))) {
              const full = await audio.extractFull(mp4Path, file.id);
              await drive.uploadAudio(recFolder, audioName, full);
              audio.cleanup([full]);
            }
          } catch (e: any) {
            console.warn(
              `[pipeline] could not retain audio for "${file.name}": ${e?.message || e}`
            );
          }
        }
      }

      // Optionally trash the source MP4 immediately. Off by default; requires the Drive
      // service account to have Editor access. Best-effort: a cleanup failure must NOT
      // fail an already-published run. (Retention sweep handles deferred deletion.)
      if (settings.deleteRecordingAfterProcessing) {
        try {
          await drive.trash(file);
        } catch (e: any) {
          console.warn(
            `[pipeline] transcribed & published, but could not trash "${file.name}" ` +
              `(grant the Drive service account Editor access): ${e?.message || e}`
          );
        }
      }

      return {
        fileId: file.id,
        fileName: file.name,
        status: "success",
        notionUrl: page.url,
      };
    }

    // Transcription-only run (Notion not configured yet).
    db()
      .prepare(
        `UPDATE runs SET status='transcribed', error=?, finished_at=? WHERE id=?`
      )
      .run(
        "Notion not configured: transcription saved, routing skipped.",
        new Date().toISOString(),
        runId
      );
    // Do NOT markProcessed/trash: re-running once Notion is set up will route it.
    return {
      fileId: file.id,
      fileName: file.name,
      status: "transcribed",
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    db()
      .prepare(`UPDATE runs SET status='failed', error=?, finished_at=? WHERE id=?`)
      .run(message, new Date().toISOString(), runId);
    // Intentionally do NOT markProcessed or trash: the file will be retried.
    return {
      fileId: file.id,
      fileName: file.name,
      status: "failed",
      error: message,
    };
  } finally {
    // Audio chunks are temporary working files; the spec keeps long-term audio elsewhere.
    // For v1 we clean the work dir to stay tidy. Remove this line to retain audio.
    audio.cleanup(audioChunks);
  }
}

// Process every new file. Returns a summary per file.
export async function processAllNew(): Promise<RunSummary[]> {
  const files = await drive.listNew();
  const results: RunSummary[] = [];
  for (const f of files) {
    results.push(await processFile(f));
  }
  return results;
}

// Re-run a single meeting by an existing run id (used by the UI "Re-run" button).
export async function rerunByRunId(runId: number): Promise<RunSummary | null> {
  const row = db()
    .prepare("SELECT file_id, file_name FROM runs WHERE id = ?")
    .get(runId) as { file_id: string; file_name: string } | undefined;
  if (!row) return null;

  // Allow reprocessing even if previously marked done.
  db().prepare("DELETE FROM processed_files WHERE file_id = ?").run(row.file_id);

  const source = row.file_id.startsWith("local:") ? "local" : "drive";
  const file: MeetingFile = {
    id: row.file_id,
    name: row.file_name,
    source: source as "local" | "drive",
    localPath:
      source === "local" && process.env.LOCAL_FIXTURE_DIR
        ? `${process.env.LOCAL_FIXTURE_DIR}/${row.file_id.replace("local:", "")}`
        : undefined,
  };
  return processFile(file);
}
