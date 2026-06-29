import { db } from "./db";
import { processAllNew, RunSummary } from "./pipeline";
import { sweepOldVideos } from "./retention";

export type PollTrigger = "cron" | "manual";

export interface PollRecord {
  id: number;
  ranAt: string;
  trigger: PollTrigger;
  found: number;
  succeeded: number;
  failed: number;
  error: string | null;
}

export interface PollResult {
  poll: PollRecord;
  results: RunSummary[]; // per-file outcomes for the caller (e.g. manual-run toast)
}

// Run one polling pass: list new files, process each, and record the outcome so the
// dashboard can show whether the poller is alive and what it found. A poll-level error
// (e.g. Drive listing fails) is captured rather than thrown, so the cron loop survives.
export async function runPoll(trigger: PollTrigger): Promise<PollResult> {
  const ranAt = new Date().toISOString();
  let results: RunSummary[] = [];
  let error: string | null = null;

  try {
    results = await processAllNew();
  } catch (e: any) {
    error = e?.message || String(e);
  }

  // Retention: after processing, trash videos past the retention window (audio kept).
  // Best-effort; never let it fail the poll.
  try {
    const sweep = await sweepOldVideos();
    if (sweep.trashed || sweep.errors) {
      console.log(
        `[retention] trashed ${sweep.trashed} old video(s), ` +
          `${sweep.skippedNoAudio} skipped (no audio), ${sweep.errors} error(s)`
      );
    }
  } catch (e: any) {
    console.warn("[retention] sweep failed:", e?.message || e);
  }

  const found = results.length;
  // 'success' and 'transcribed' both count as succeeded; only 'failed' is a failure.
  const failed = results.filter((r) => r.status === "failed").length;
  const succeeded = found - failed;

  const id = db()
    .prepare(
      `INSERT INTO polls (ran_at, trigger, found, succeeded, failed, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(ranAt, trigger, found, succeeded, failed, error).lastInsertRowid as number;

  return {
    poll: { id, ranAt, trigger, found, succeeded, failed, error },
    results,
  };
}

export function recentPolls(limit = 15): PollRecord[] {
  return db()
    .prepare(
      `SELECT id, ran_at AS ranAt, trigger, found, succeeded, failed, error
       FROM polls ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as PollRecord[];
}
