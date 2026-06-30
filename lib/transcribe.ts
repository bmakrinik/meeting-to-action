import fs from "node:fs";
import OpenAI from "openai";
import type { AppSettings } from "./settings";
import { transcriptionCostUsd, hasAudioRate, type StageCost } from "./pricing";

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
  usage: StageCost; // transcription cost/usage (billed per audio minute)
}

// Transcribe one or more audio chunks and concatenate. The model id comes from settings
// so it can be swapped in the UI (e.g. gpt-4o-transcribe-diarize <-> gpt-4o-transcribe).
// audioSeconds is the total meeting duration (from audio.extract) and is the basis for
// transcription cost, which OpenAI bills per minute of audio rather than per token.
export async function run(
  chunks: string[],
  settings: AppSettings,
  audioSeconds = 0
): Promise<TranscriptResult> {
  const parts: string[] = [];
  const raw: unknown[] = [];
  // Token usage is captured opportunistically: gpt-4o-transcribe may return a usage object,
  // but the json/diarized_json responses often omit it, so it is telemetry only, not billing.
  let inputTokens = 0;
  let outputTokens = 0;

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
      // Bias the model toward connected speech to cut wrong-language hallucinations
      // during silence. Not supported by the diarize model, which rejects a prompt.
      req.prompt = "This is a business meeting.";
    }
    const resp: any = await client().audio.transcriptions.create(req);
    raw.push(resp);
    parts.push(formatResponse(resp));
    // gpt-4o-transcribe may include a usage object ({input_tokens, output_tokens}); sum it
    // when present. Not all models/response formats return it, hence the guards.
    const u = resp?.usage;
    if (u) {
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
    }
  }

  const usage: StageCost = {
    stage: "transcription",
    model: settings.transcribeModel,
    calls: chunks.length,
    audioSeconds,
    promptTokens: inputTokens || undefined,
    completionTokens: outputTokens || undefined,
    totalTokens: inputTokens + outputTokens || undefined,
    costUsd: transcriptionCostUsd(settings.transcribeModel, audioSeconds),
    rateMissing: !hasAudioRate(settings.transcribeModel),
  };

  return { text: parts.join("\n").trim(), rawSegments: raw, usage };
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
