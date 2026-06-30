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

// Strong Greek-forcing prompt for the fallback re-transcription (plain model only — the
// diarize model rejects a prompt, which is why it drifts to English in the first place).
const GREEK_PROMPT =
  "Μετάγραψε το ηχητικό αυτολεξεί στα Ελληνικά. ΜΗΝ μεταφράζεις στα Αγγλικά. " +
  "Κράτα τους αγγλικούς και τεχνικούς όρους όπως ακούγονται.";

// Fraction of letters that are Greek. Used to detect a chunk that the model translated
// to English when Greek was expected.
function greekRatio(t: string): number {
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (!letters) return 1; // no letters at all -> don't flag
  const greek = (t.match(/[Ͱ-Ͽἀ-῿]/g) || []).length;
  return greek / letters;
}

function letterCount(t: string): number {
  return (t.match(/\p{L}/gu) || []).length;
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
  const isDiarize = /diarize/i.test(settings.transcribeModel);
  // Token usage is captured opportunistically: gpt-4o-transcribe may return a usage object,
  // but the json/diarized_json responses often omit it, so it is telemetry only, not billing.
  let inputTokens = 0;
  let outputTokens = 0;

  // Pass 1: transcribe every chunk.
  const results: { text: string; raw: unknown; chunkPath: string }[] = [];
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
      // Plain transcription models return a single `text` field, and accept a prompt.
      // Language-neutral: transcribe in whatever is spoken; don't translate.
      req.response_format = "json";
      req.prompt =
        "This is a business meeting. Transcribe verbatim in the spoken language; do not translate.";
    }
    const resp: any = await client().audio.transcriptions.create(req);
    results.push({ text: formatResponse(resp), raw: resp, chunkPath });
    // gpt-4o-transcribe may include a usage object ({input_tokens, output_tokens}); sum it
    // when present. Not all models/response formats return it, hence the guards.
    const u = resp?.usage;
    if (u) {
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
    }
  }

  // Decide the meeting's dominant script. We only salvage toward Greek when the meeting
  // as a whole is predominantly Greek, so an English-only meeting is never forced to Greek.
  let greek = 0;
  let latin = 0;
  for (const r of results) {
    greek += (r.text.match(/[Ͱ-Ͽἀ-῿]/g) || []).length;
    latin += (r.text.match(/[A-Za-z]/g) || []).length;
  }
  const greekDominant = greek > 0 && greek >= latin;

  // Pass 2: in an otherwise-Greek meeting, salvage any chunk the diarize model translated
  // to English by re-transcribing it with the plain model forcing Greek (loses speaker
  // labels for that chunk, keeps the language).
  if (greekDominant) {
    for (const r of results) {
      if (letterCount(r.text) <= 80 || greekRatio(r.text) >= 0.2) continue;
      try {
        const retry: any = await client().audio.transcriptions.create({
          file: fs.createReadStream(r.chunkPath) as any,
          model: "gpt-4o-transcribe",
          language: "el",
          response_format: "json",
          prompt: GREEK_PROMPT,
        } as any);
        const retryText = (retry.text || "").trim();
        if (retryText && greekRatio(retryText) >= 0.2) {
          r.text = retryText;
          r.raw = retry;
        }
      } catch {
        /* keep the original chunk if the salvage attempt fails */
      }
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

  return {
    text: results.map((r) => r.text).join("\n").trim(),
    rawSegments: results.map((r) => r.raw),
    usage,
  };
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
