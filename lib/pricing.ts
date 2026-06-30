// OpenAI pricing and per-meeting cost math, in one place.
//
// Rates below are USD, as published by OpenAI as of 2026-06. They change over time, so:
//  - update them HERE (single source of truth), and
//  - note that pipeline.ts snapshots the COMPUTED cost onto each run at processing time,
//    so historical rows keep the price that was actually in effect, not whatever this
//    table says later.
//
// Two different billing models are involved:
//  - Chat models (cleaning + analysis) are billed per token (input/output).
//  - Transcription models are billed per MINUTE of audio. The json/diarized_json responses
//    this app uses do not return token usage on the installed SDK, so audio minutes are the
//    reliable, model-uniform basis for transcription cost (tokens are captured opportunistically
//    for telemetry only).

interface ChatRate {
  inputPerM: number; // USD per 1M input (prompt) tokens
  outputPerM: number; // USD per 1M output (completion) tokens
}

interface AudioRate {
  perMinute: number; // USD per minute of audio
}

const CHAT_RATES: Record<string, ChatRate> = {
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
};

const AUDIO_RATES: Record<string, AudioRate> = {
  "gpt-4o-transcribe": { perMinute: 0.006 },
  // The diarize variant has no separately published rate; treat it as the gpt-4o-transcribe
  // family rate. Update if OpenAI publishes a distinct diarization price.
  "gpt-4o-transcribe-diarize": { perMinute: 0.006 },
  "gpt-4o-mini-transcribe": { perMinute: 0.003 },
  "whisper-1": { perMinute: 0.006 },
};

// Per-stage cost record, stored on the run and surfaced to the dashboard.
export interface StageCost {
  stage: "transcription" | "cleaning" | "analysis";
  model: string;
  calls: number; // number of API calls in this stage (chunked stages make several)
  promptTokens?: number; // chat input tokens (transcription: audio input tokens if reported)
  completionTokens?: number; // chat output tokens (transcription: output tokens if reported)
  totalTokens?: number;
  audioSeconds?: number; // transcription only
  costUsd: number;
  // True when no rate was found for this model, so costUsd is a placeholder 0, not a real
  // price. Surfaced in the UI as "rate n/a" so a model swap never reads as a precise $0.
  rateMissing?: boolean;
}

export interface CostBreakdown {
  audioSeconds: number;
  transcription: StageCost;
  cleaning: StageCost;
  analysis: StageCost;
  totalUsd: number;
}

const warned = new Set<string>();
function warnUnknown(kind: string, model: string): void {
  const key = `${kind}:${model}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[pricing] no ${kind} rate for model "${model}"; costing it at $0. Add it to lib/pricing.ts.`
  );
}

// Exact match, then a prefix match so dated snapshots (e.g. "gpt-4o-2024-08-06") resolve to
// their family rate.
function lookup<T>(table: Record<string, T>, model: string): T | null {
  if (table[model]) return table[model];
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]; // longest (most specific) prefix wins
  return key ? table[key] : null;
}

// Transcription-family ids share the "gpt-4o" prefix but are NOT chat models, so they must
// never resolve to a chat rate via the prefix fallback.
function lookupChat(model: string): ChatRate | null {
  if (/transcribe|whisper/i.test(model)) return null;
  return lookup(CHAT_RATES, model);
}

// Whether a real (non-placeholder) rate exists for a model. Used to flag a run's cost as
// incomplete rather than reporting a falsely-precise $0 after a model swap to an unpriced id.
export function hasChatRate(model: string): boolean {
  return !!lookupChat(model);
}
export function hasAudioRate(model: string): boolean {
  return !!lookup(AUDIO_RATES, model);
}

// Cost of a chat.completions call (cleaning or analysis), from real token usage.
export function chatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const r = lookupChat(model);
  if (!r) {
    warnUnknown("chat", model);
    return 0;
  }
  return (promptTokens * r.inputPerM + completionTokens * r.outputPerM) / 1_000_000;
}

// Cost of transcription, billed by audio duration.
export function transcriptionCostUsd(model: string, audioSeconds: number): number {
  const r = lookup(AUDIO_RATES, model);
  if (!r) {
    warnUnknown("transcription", model);
    return 0;
  }
  return (audioSeconds / 60) * r.perMinute;
}
