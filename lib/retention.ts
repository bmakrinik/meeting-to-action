import { getSettings, recordingsFolderIds } from "./settings";
import * as drive from "./drive";

// Strip the .mp4/.m4a extension so a video and its audio copy share a base name.
function baseName(n: string): string {
  return (n || "").replace(/\.(mp4|m4a)$/i, "");
}

export interface SweepResult {
  trashed: number;
  skippedNoAudio: number;
  errors: number;
}

// Delete videos older than the retention window, but ONLY when a matching audio copy
// exists in the folder, so a video is never removed without its archival audio.
// Runs in Drive mode only; no-op for local fixtures or when retention is disabled.
export async function sweepOldVideos(): Promise<SweepResult> {
  const result: SweepResult = { trashed: 0, skippedNoAudio: 0, errors: 0 };

  const days = getSettings().videoRetentionDays;
  if (!days || days <= 0) return result;
  if (process.env.LOCAL_FIXTURE_DIR) return result; // local fixtures are never touched
  const folderIds = recordingsFolderIds();
  if (!folderIds.length) return result;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Sweep each configured folder independently (audio + video live in the same folder).
  for (const folderId of folderIds) {
    const files = await drive.listFolderFiles(folderId);
    const audioBases = new Set(
      files
        .filter((f) => /^audio\//.test(f.mimeType) || /\.m4a$/i.test(f.name))
        .map((f) => baseName(f.name))
    );
    for (const f of files) {
      if (f.mimeType !== "video/mp4") continue;
      const created = f.createdTime ? Date.parse(f.createdTime) : NaN;
      if (!(created < cutoff)) continue; // not old enough (or unknown date)
      if (!audioBases.has(baseName(f.name))) {
        result.skippedNoAudio++; // never delete a video that has no audio copy
        continue;
      }
      try {
        await drive.trashById(f.id);
        result.trashed++;
      } catch {
        result.errors++;
      }
    }
  }
  return result;
}
