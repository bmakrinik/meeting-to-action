import { db } from "./db";

// App configuration editable from the Settings UI. Stored as one JSON blob in settings table.
export interface EnrolledSpeaker {
  // The label the diarizer is expected to emit (or a hint phrase) mapped to the real person.
  // For gpt-4o-transcribe-diarize you can enroll up to 4 named speakers.
  name: string;
  // Optional voice/role hint used in the post-processing prompt to disambiguate.
  hint?: string;
}

export interface GlossaryEntry {
  // What the transcriber tends to mishear -> the correct product/domain term.
  wrong: string;
  right: string;
}

export interface TeamMember {
  // Company roster used to resolve action-item owners to real people.
  name: string;
  role?: string;
}

export interface AppSettings {
  transcribeModel: string; // e.g. "gpt-4o-transcribe-diarize"
  postprocessModel: string; // analysis pass (summary + action items), e.g. "gpt-4o"
  // Cleaning pass (transcript tidy-up) model. The cleaning pass is mechanical and the bulk
  // of post-processing token volume, so a cheaper model here cuts cost sharply. Empty falls
  // back to postprocessModel. e.g. "gpt-4o-mini".
  cleanModel: string;
  language: string; // ISO hint, e.g. "el"
  pollIntervalMinutes: number; // cron cadence
  cronEnabled: boolean;
  enrolledSpeakers: EnrolledSpeaker[]; // <= 4 meaningful for diarize enrollment
  glossary: GlossaryEntry[];
  teamRoster: TeamMember[]; // company members, for resolving action-item owners by name
  vocabulary: string[]; // correct domain terms / proper nouns; the LLM snaps mangled mentions to these
  notionDatabaseId: string; // overrides env if set
  meetRecordingsFolderId: string; // legacy single folder (kept for back-compat with stored settings)
  meetRecordingsFolderIds: string[]; // Shared Drive folders to poll
  // When true, trash the source MP4 in Drive immediately after a successful Notion write.
  // Requires the Drive service account to have Editor (write) access. Off by default
  // so the app works with read-only access and never deletes recordings unexpectedly.
  deleteRecordingAfterProcessing: boolean;
  // Retention: keep the video this many days, then a sweep trashes it (a small audio copy
  // is retained in the Shared Drive on processing). 0 disables the sweep (videos kept).
  videoRetentionDays: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  // Plain model is the reliable default; the diarize model currently times out on long files.
  transcribeModel: "gpt-4o-transcribe",
  postprocessModel: "gpt-4o",
  // Cleaning is mechanical, so the cheaper model handles it; analysis stays on gpt-4o.
  cleanModel: "gpt-4o-mini",
  language: "el",
  pollIntervalMinutes: 15,
  cronEnabled: false,
  enrolledSpeakers: [],
  glossary: [],
  teamRoster: [],
  vocabulary: [],
  notionDatabaseId: process.env.NOTION_DATABASE_ID || "",
  meetRecordingsFolderId: "",
  meetRecordingsFolderIds: process.env.MEET_RECORDINGS_FOLDER_ID
    ? [process.env.MEET_RECORDINGS_FOLDER_ID]
    : [],
  deleteRecordingAfterProcessing: false,
  videoRetentionDays: 30,
};

const SETTINGS_KEY = "app_settings";

// All Drive folders to poll: the UI list, plus the legacy single field and the env var,
// de-duplicated. Empty if nothing is configured.
export function recordingsFolderIds(): string[] {
  const s = getSettings();
  const all = [
    ...(s.meetRecordingsFolderIds || []),
    s.meetRecordingsFolderId,
    process.env.MEET_RECORDINGS_FOLDER_ID || "",
  ];
  return Array.from(new Set(all.map((x) => (x || "").trim()).filter(Boolean)));
}

export function getSettings(): AppSettings {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    // Merge so new fields added over time get sane defaults.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Partial<AppSettings>): AppSettings {
  const merged = { ...getSettings(), ...next };
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}
