import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WORK_DIR = process.env.WORK_DIR || path.join(process.cwd(), "data", "work");
// Allow overriding the ffmpeg binary path (e.g. ~/.local/bin/ffmpeg).
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// Per-chunk limits we must stay under:
//  - OpenAI audio endpoints cap requests at 25 MB.
//  - gpt-4o-transcribe caps audio at 1400 s; diarize models also have duration caps.
// 16 kHz mono 64 kbps ~= 0.48 MB/min, so 20-minute chunks are ~9.6 MB and ~1200 s:
// comfortably under both limits.
const CHUNK_SECONDS = 1200;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`))
    );
  });
}

// Read media duration (seconds) by parsing ffmpeg's stderr. `ffmpeg -i` with no output
// exits non-zero but prints "Duration: HH:MM:SS.ss", which is all we need.
function getDuration(input: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-i", input], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return reject(new Error("could not read audio duration from ffmpeg"));
      resolve(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
    });
  });
}

export interface ExtractResult {
  // One or more audio chunks, each under the API size + duration caps, in order.
  chunks: string[];
  // Total audio duration in seconds (already measured by ffmpeg; surfaced so the caller can
  // cost transcription per-minute without a second ffmpeg pass).
  durationSeconds: number;
}

const AUDIO_ARGS = [
  "-vn",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-c:a",
  "aac",
  "-b:a",
  "64k",
];

// Extract 16 kHz mono audio from an MP4, discarding video, split into time-based
// chunks so each call stays under the transcription model's size and duration caps.
// chunkSeconds is configurable because the diarize model is far slower and needs
// smaller chunks to finish before the API client times out.
export async function extract(
  mp4Path: string,
  baseId: string,
  chunkSeconds: number = CHUNK_SECONDS
): Promise<ExtractResult> {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const safeId = baseId.replace(/[^a-zA-Z0-9_.-]/g, "_");

  const duration = await getDuration(mp4Path);

  // Short enough: single file.
  if (duration <= chunkSeconds) {
    const out = path.join(WORK_DIR, `${safeId}.m4a`);
    await run(FFMPEG, ["-y", "-i", mp4Path, ...AUDIO_ARGS, out]);
    return { chunks: [out], durationSeconds: duration };
  }

  // Long: cut into fixed time windows, re-encoding each (accurate, container-agnostic).
  const chunks: string[] = [];
  let idx = 0;
  for (let start = 0; start < duration; start += chunkSeconds, idx++) {
    const out = path.join(WORK_DIR, `${safeId}_part${String(idx).padStart(3, "0")}.m4a`);
    await run(FFMPEG, [
      "-y",
      "-ss",
      String(start),
      "-t",
      String(chunkSeconds),
      "-i",
      mp4Path,
      ...AUDIO_ARGS,
      out,
    ]);
    chunks.push(out);
  }
  return { chunks, durationSeconds: duration };
}

// Extract the whole meeting as a single 16 kHz mono audio file (no chunking),
// used as the small archival copy that replaces the video after retention.
export async function extractFull(mp4Path: string, baseId: string): Promise<string> {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const safeId = baseId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const out = path.join(WORK_DIR, `${safeId}.full.m4a`);
  await run(FFMPEG, ["-y", "-i", mp4Path, ...AUDIO_ARGS, out]);
  return out;
}

// Remove an extracted audio file/chunk after processing.
export function cleanup(files: string[]): void {
  for (const f of files) fs.rmSync(f, { force: true });
}
