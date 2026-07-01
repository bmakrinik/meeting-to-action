import fs from "node:fs";
import path from "node:path";
import { google, drive_v3 } from "googleapis";
import { db } from "./db";
import { recordingsFolderIds } from "./settings";

// A meeting file to process, abstracted over "real Drive" vs "local fixture" sources.
export interface MeetingFile {
  id: string; // Drive file id, or "local:<filename>" for fixtures
  name: string;
  source: "drive" | "local";
  isVideo: boolean; // true for .mp4 recordings; false for standalone audio files
  localPath?: string; // populated for fixtures
  createdTime?: string; // ISO; when the recording was created (~ meeting time)
  folderId?: string; // the Drive folder it was found in (for audio retain-upload)
  calendar?: CalendarMeta; // organizer/guests, stamped on the file's description by the mover script
}

// Media inputs the app can transcribe: Meet's .mp4 recordings plus standalone audio
// files. ffmpeg reads all of these (it probes by content), so the transcription
// back-half is format-agnostic; this list only gates discovery.
const AUDIO_EXTS = ["mp3", "m4a", "wav", "aac", "flac", "ogg", "opus", "webm"];
const MEDIA_EXTS = ["mp4", ...AUDIO_EXTS];
const MEDIA_EXT_RE = new RegExp(`\\.(${MEDIA_EXTS.join("|")})$`, "i");

// Is this filename a media file we can ingest?
export function isMediaFile(name: string): boolean {
  return MEDIA_EXT_RE.test(name);
}

// Strip a supported media extension from a filename (used for titles and dedup keys).
export function stripMediaExt(name: string): string {
  return (name || "").replace(MEDIA_EXT_RE, "");
}

// The lowercased media extension of a filename ("mp4", "mp3", ...), or "" if none.
function mediaExt(name: string): string {
  const m = name.match(MEDIA_EXT_RE);
  return m ? m[1].toLowerCase() : "";
}

// A file is treated as video only when it's an .mp4; everything else is audio.
function isVideoName(name: string): boolean {
  return /\.mp4$/i.test(name);
}

// Calendar info the per-user mover script writes into the recording's Drive description
// (as JSON), so the app gets authoritative attendees/host without calendar access of its own.
export interface CalendarMeta {
  organizer: string | null;
  invited: string[];
  attendees: string[];
}

function parseCalendarMeta(description?: string | null): CalendarMeta | undefined {
  if (!description) return undefined;
  try {
    const m = JSON.parse(description);
    if (m && (m.organizer || m.invited || m.attendees)) {
      return {
        organizer: m.organizer ?? null,
        invited: Array.isArray(m.invited) ? m.invited.map(String) : [],
        attendees: Array.isArray(m.attendees) ? m.attendees.map(String) : [],
      };
    }
  } catch {
    /* description wasn't our JSON; ignore */
  }
  return undefined;
}

const WORK_DIR = process.env.WORK_DIR || path.join(process.cwd(), "data", "work");
fs.mkdirSync(WORK_DIR, { recursive: true });

function isProcessed(fileId: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM processed_files WHERE file_id = ?")
    .get(fileId);
  return !!row;
}

// ---------- Local fixture mode (no Drive credentials needed) ----------

function listLocalFixtures(): MeetingFile[] {
  const dir = process.env.LOCAL_FIXTURE_DIR;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => isMediaFile(f))
    .map((f) => {
      const full = path.join(dir, f);
      return {
        id: `local:${f}`,
        name: f,
        source: "local" as const,
        isVideo: isVideoName(f),
        localPath: full,
        createdTime: safeMtime(full),
      };
    });
}

// File mtime as ISO, best-effort (used as the meeting time for local fixtures).
function safeMtime(p: string): string | undefined {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return undefined;
  }
}

// ---------- Google Drive mode ----------

function driveClient(): drive_v3.Drive {
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credPath || !fs.existsSync(credPath)) {
    throw new Error(
      "GOOGLE_CREDENTIALS_PATH not set or file missing. Set LOCAL_FIXTURE_DIR to test without Drive."
    );
  }
  const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));

  // Support a service-account JSON directly.
  if (creds.type === "service_account") {
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    return google.drive({ version: "v3", auth: auth as any });
  }

  // Otherwise treat as an OAuth client; reuse a cached token if present.
  const { client_id, client_secret, redirect_uris } =
    creds.installed || creds.web || creds;
  const oauth = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0]
  );
  const tokenPath = process.env.GOOGLE_TOKEN_PATH;
  if (tokenPath && fs.existsSync(tokenPath)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf8")));
  } else {
    throw new Error(
      "OAuth token missing. Complete the Google OAuth flow and save the token to GOOGLE_TOKEN_PATH."
    );
  }
  return google.drive({ version: "v3", auth: oauth });
}

async function listDriveFiles(): Promise<MeetingFile[]> {
  const folderIds = recordingsFolderIds();
  if (!folderIds.length)
    throw new Error("No Meet Recordings folder configured (Settings or env).");
  const drive = driveClient();
  const out: MeetingFile[] = [];
  for (const folderId of folderIds) {
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        // Meet's .mp4 recordings plus any audio/* file dropped in the folder.
        q: `'${folderId}' in parents and (mimeType = 'video/mp4' or mimeType contains 'audio/') and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, createdTime, description)",
        orderBy: "createdTime",
        pageSize: 100,
        // Required so a folder living in a Shared Drive is traversed.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageToken,
      });
      for (const f of res.data.files || []) {
        const name = f.name || f.id!;
        // Skip audio/* results whose extension we don't support (keeps behavior
        // predictable and consistent with the local-fixture allowlist).
        if (!isMediaFile(name)) continue;
        out.push({
          id: f.id!,
          name,
          source: "drive" as const,
          isVideo: f.mimeType === "video/mp4" || isVideoName(name),
          createdTime: f.createdTime || undefined,
          folderId,
          calendar: parseCalendarMeta(f.description),
        });
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }
  return out;
}

// Resolve the meeting time for a file: use the known createdTime if present, otherwise
// fetch it (Drive) or stat it (local). Falls back to undefined if unavailable.
export async function meetingTime(file: MeetingFile): Promise<string | undefined> {
  if (file.createdTime) return file.createdTime;
  if (file.source === "local") {
    return file.localPath ? safeMtime(file.localPath) : undefined;
  }
  try {
    const res = await driveClient().files.get({
      fileId: file.id,
      fields: "createdTime",
      supportsAllDrives: true,
    });
    return res.data.createdTime || undefined;
  } catch {
    return undefined;
  }
}

// ---------- Public API ----------

// New, unprocessed meeting files (Drive or local fixtures), oldest first.
export async function listNew(): Promise<MeetingFile[]> {
  const all =
    process.env.LOCAL_FIXTURE_DIR && process.env.LOCAL_FIXTURE_DIR.length > 0
      ? listLocalFixtures()
      : await listDriveFiles();
  return all.filter((f) => !isProcessed(f.id));
}

// Download (or copy) a recording to the work dir and return its local path. Keeps the
// source's own extension (mp4/mp3/wav/...) so the working copy reflects its real format.
export async function download(file: MeetingFile): Promise<string> {
  if (file.source === "local") {
    return file.localPath!;
  }
  const ext = mediaExt(file.name) || "mp4";
  const dest = path.join(WORK_DIR, `${file.id}.${ext}`);
  const drive = driveClient();
  const res = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    (res.data as NodeJS.ReadableStream)
      .on("end", () => resolve())
      .on("error", reject)
      .pipe(out);
  });
  return dest;
}

// Move the source MP4 to trash. No-op for local fixtures (we never delete the user's test files).
export async function trash(file: MeetingFile): Promise<void> {
  if (file.source === "local") return;
  await trashById(file.id);
}

// Trash any Drive file by id (used by the retention sweep).
export async function trashById(fileId: string): Promise<void> {
  await driveClient().files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
}

// List every (non-trashed) file in a folder, across Shared Drives.
export async function listFolderFiles(folderId: string): Promise<DriveFileInfo[]> {
  const drive = driveClient();
  const out: DriveFileInfo[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, createdTime)",
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    for (const f of res.data.files || [])
      out.push({
        id: f.id!,
        name: f.name || f.id!,
        mimeType: f.mimeType || "",
        createdTime: f.createdTime || undefined,
      });
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

// Does a file with this exact name already exist in the folder?
export async function fileExistsInFolder(folderId: string, name: string): Promise<boolean> {
  const res = await driveClient().files.list({
    q: `'${folderId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).length > 0;
}

// Upload an audio file into the folder (the small archival copy of a meeting).
export async function uploadAudio(
  folderId: string,
  name: string,
  localPath: string
): Promise<string> {
  const res = await driveClient().files.create({
    requestBody: { name, parents: [folderId], mimeType: "audio/mp4" },
    media: { mimeType: "audio/mp4", body: fs.createReadStream(localPath) },
    fields: "id",
    supportsAllDrives: true,
  });
  return res.data.id!;
}

export function markProcessed(file: MeetingFile): void {
  db()
    .prepare(
      `INSERT INTO processed_files (file_id, file_name, processed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(file_id) DO NOTHING`
    )
    .run(file.id, file.name, new Date().toISOString());
}
