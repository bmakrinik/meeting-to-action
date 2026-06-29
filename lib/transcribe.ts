import fs from "node:fs";
import OpenAI from "openai";
import type { AppSettings } from "./settings";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set.");
  // Long timeout: the diarize model can take several minutes per chunk. Avoid the SDK's
  // 10-minute default silently retrying and looping forever. One retry, not the default 2.
  _client = new OpenAI({ apiKey, timeout: 20 * 60 * 1000, maxRetries: 1 });
  return _client;
}

// A diarized transcript: speaker-labeled segments joined into readable text.
export interface TranscriptResult {
  text: string; // full transcript, "Speaker N: ..." lines when diarization is available
  rawSegments: unknown; // provider response kept for debugging
}

// Transcribe one or more audio chunks and concatenate. The model id comes from settings
// so it can be swapped in the UI (e.g. gpt-4o-transcribe-diarize <-> gpt-4o-transcribe).
export async function run(
  chunks: string[],
  settings: AppSettings
): Promise<TranscriptResult> {
  const parts: string[] = [];
  const raw: unknown[] = [];

  const isDiarize = /diarize/i.test(settings.transcribeModel);

  for (const chunkPath of chunks) {
    const req: any = {
      file: fs.createReadStream(chunkPath) as any,
      model: settings.transcribeModel,
      language: settings.language || undefined,
    };
    if (isDiarize) {
      // Diarization models require an explicit chunking strategy and return
      // speaker-labeled segments in their diarized JSON response.
      req.chunking_strategy = "auto";
      req.response_format = "diarized_json";
    } else {
      // Plain transcription models return a single `text` field.
      req.response_format = "json";
    }
    const resp: any = await client().audio.transcriptions.create(req);
    raw.push(resp);
    parts.push(formatResponse(resp));
  }

  return { text: parts.join("\n").trim(), rawSegments: raw };
}

// Normalize whatever the model returns into "Speaker N: text" lines when diarization
// info is present, otherwise plain text. Diarization-capable models return segment
// arrays with speaker labels; plain transcribe models return a single `text` field.
function formatResponse(resp: any): string {
  // Diarized responses carry per-segment speaker labels. Field names vary by model
  // (speaker / speaker_id / speaker_label), and segments may sit under `segments` or `words`.
  const segments = resp?.segments || resp?.words;
  const speakerOf = (s: any) => s?.speaker ?? s?.speaker_id ?? s?.speaker_label;
  if (Array.isArray(segments) && segments.length && speakerOf(segments[0]) != null) {
    const lines: string[] = [];
    let current = "";
    let buf: string[] = [];
    for (const s of segments) {
      const spk = String(speakerOf(s) ?? "");
      if (spk !== current) {
        if (buf.length) lines.push(`${current}: ${buf.join(" ").trim()}`);
        current = spk;
        buf = [];
      }
      buf.push((s.text || s.word || "").trim());
    }
    if (buf.length) lines.push(`${current}: ${buf.join(" ").trim()}`);
    return lines.join("\n");
  }
  // Fallback: plain transcript text.
  return (resp?.text || "").trim();
}
