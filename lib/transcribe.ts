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

// ---- Salvage configuration: ISO language hint -> script detection + forcing prompt ----
//
// The diarize model sometimes translates a chunk to English even when another language is
// spoken (it rejects a prompt, which is why it drifts). We detect that drift *by script*:
// if the meeting is predominantly written in a non-Latin script but one chunk came back
// mostly Latin letters, we re-transcribe that chunk with the plain model, forcing the target
// language. This is only meaningful for languages whose script is visibly distinct from
// Latin; Latin-vs-Latin drift (e.g. Spanish -> English) is undetectable by script, so those
// languages are deliberately absent from this table and salvage never runs for them. That
// preserves the guarantee that an English-only meeting is never altered.
//
// `script` is a regex character-class body (no brackets) covering the language's letters; all
// ranges are in the BMP, so a non-`u` global regex counts them correctly, matching the
// original Greek idiom which also used a non-`u` /g regex. `prompt`, when present, is a NATIVE
// forcing prompt: OpenAI guidance is that a transcription prompt in the audio's own language
// biases the model more strongly than an English meta-instruction, so the primary language
// (Greek) keeps its native prompt verbatim. Languages without a native prompt fall back to an
// English instruction that names the target language (forcingPrompt). A language can be
// upgraded to native quality later by adding one `prompt:` field, with no other code change.
interface ScriptRule {
  script: string; // regex character-class body covering the language's letters (BMP only)
  name: string; // English name of the language, used in the fallback prompt
  prompt?: string; // optional native forcing prompt; preferred over the English fallback
}

const SCRIPT_RULES: Record<string, ScriptRule> = {
  // Greek keeps the exact ranges (0370-03FF + 1F00-1FFF) and native prompt it had before, so
  // settings.language="el" behaves identically to the original Greek-hardcoded implementation.
  el: {
    script: "Ͱ-Ͽἀ-῿",
    name: "Greek",
    prompt:
      "Μετάγραψε το ηχητικό αυτολεξεί στα Ελληνικά. ΜΗΝ μεταφράζεις στα Αγγλικά. " +
      "Κράτα τους αγγλικούς και τεχνικούς όρους όπως ακούγονται.",
  },
  // Cyrillic (0400-04FF) covers Russian/Ukrainian/Bulgarian/Serbian and related languages.
  ru: { script: "Ѐ-ӿ", name: "Russian" },
  uk: { script: "Ѐ-ӿ", name: "Ukrainian" },
  bg: { script: "Ѐ-ӿ", name: "Bulgarian" },
  sr: { script: "Ѐ-ӿ", name: "Serbian" },
  // Arabic (0600-06FF + Arabic Supplement 0750-077F) covers Arabic/Persian/Urdu.
  ar: { script: "؀-ۿݐ-ݿ", name: "Arabic" },
  fa: { script: "؀-ۿݐ-ݿ", name: "Persian" },
  ur: { script: "؀-ۿݐ-ݿ", name: "Urdu" },
  // Hebrew (0590-05FF).
  he: { script: "֐-׿", name: "Hebrew" },
  // Devanagari (0900-097F) covers Hindi/Marathi.
  hi: { script: "ऀ-ॿ", name: "Hindi" },
  mr: { script: "ऀ-ॿ", name: "Marathi" },
  // Thai (0E00-0E7F).
  th: { script: "฀-๿", name: "Thai" },
  // Japanese: Hiragana (3040-309F) + Katakana (30A0-30FF) + CJK Ext A (3400-4DBF) + CJK (4E00-9FFF).
  ja: { script: "぀-ヿ㐀-䶿一-鿿", name: "Japanese" },
  // Chinese: CJK Ext A (3400-4DBF) + CJK Unified (4E00-9FFF).
  zh: { script: "㐀-䶿一-鿿", name: "Chinese" },
  // Korean: Hangul syllables (AC00-D7AF) + Jamo (1100-11FF) + compatibility Jamo (3130-318F).
  ko: { script: "가-힯ᄀ-ᇿ㄰-㆏", name: "Korean" },
};

// Fraction of a chunk that we re-transcribe only when it stays below this; mirrors the old 0.2.
const EXPECTED_SCRIPT_RATIO = 0.2;
// Don't bother salvaging very short chunks (too little signal); mirrors the old <=80 guard.
const SALVAGE_MIN_LETTERS = 80;

// Resolve the salvage rule for an ISO hint. Normalizes case and strips a region/script subtag
// ("el-GR", "zh_Hans" -> "el", "zh"). Returns null for Latin-script or unknown/empty/undefined
// languages, which makes salvage a strict no-op so an English-only meeting is never altered.
function scriptRuleFor(language: string | undefined): ScriptRule | null {
  if (!language) return null;
  const base = language.toLowerCase().split(/[-_]/)[0];
  return SCRIPT_RULES[base] ?? null;
}

// Forcing prompt for the salvage retry: the native prompt when we have one (best quality, per
// OpenAI's guidance that a same-language prompt biases output more strongly), otherwise a
// generic English instruction naming the target language so the feature works for any script.
function forcingPrompt(rule: ScriptRule): string {
  return (
    rule.prompt ??
    `Transcribe the audio verbatim in ${rule.name}. Do NOT translate to English. ` +
      `Keep English and technical terms as spoken.`
  );
}

// Count regex matches in a string. The caller passes a fresh /g regex each time; we use
// .match() (not .test()) so the global flag's stateful lastIndex can never leak across calls.
function countMatches(t: string, re: RegExp): number {
  return (t.match(re) || []).length;
}

// Fraction of letters that belong to the expected script. Used to detect a chunk that the
// model translated to English when the expected script was spoken. Generalized from the old
// greekRatio: \p{L} needs the u flag; no letters at all -> 1 (don't flag). A fresh /g regex is
// built per call. (Combining-mark scripts like Thai/Devanagari can push this above 1.0 because
// dependent vowel signs are \p{M} not \p{L}; harmless since the value only feeds a >= 0.2 gate
// and pure-English still scores 0.)
function expectedScriptRatio(t: string, scriptClass: string): number {
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (!letters) return 1; // no letters at all -> don't flag
  return countMatches(t, new RegExp("[" + scriptClass + "]", "g")) / letters;
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

  // Resolve the salvage rule from the language hint. Null for Latin-script or unknown
  // languages (en, es, fr, "", undefined): script cannot distinguish Latin-vs-Latin drift, so
  // the entire pass-2 block (including the dominance computation) is skipped and an English-only
  // meeting is byte-for-byte unchanged.
  const rule = scriptRuleFor(settings.language);
  if (rule) {
    // Decide the meeting's dominant script. We only salvage toward the expected script when the
    // meeting as a whole is predominantly that script, so a mostly-English meeting that was
    // mistagged is never force-converted. A fresh /g regex per use, .match() only (never
    // .test()), avoids the stateful-lastIndex hazard of a shared global regex.
    let expected = 0;
    let latin = 0;
    for (const r of results) {
      expected += countMatches(r.text, new RegExp("[" + rule.script + "]", "g"));
      latin += countMatches(r.text, /[A-Za-z]/g);
    }
    const expectedDominant = expected > 0 && expected >= latin;

    // Pass 2: in an otherwise expected-script meeting, salvage any chunk the diarize model
    // translated to English by re-transcribing it with the plain model forcing the expected
    // language (loses speaker labels for that chunk, keeps the language).
    if (expectedDominant) {
      for (const r of results) {
        if (
          letterCount(r.text) <= SALVAGE_MIN_LETTERS ||
          expectedScriptRatio(r.text, rule.script) >= EXPECTED_SCRIPT_RATIO
        )
          continue;
        try {
          const retry: any = await client().audio.transcriptions.create({
            file: fs.createReadStream(r.chunkPath) as any,
            model: "gpt-4o-transcribe",
            language: settings.language,
            response_format: "json",
            prompt: forcingPrompt(rule),
          } as any);
          const retryText = (retry.text || "").trim();
          if (retryText && expectedScriptRatio(retryText, rule.script) >= EXPECTED_SCRIPT_RATIO) {
            r.text = retryText;
            r.raw = retry;
          }
        } catch {
          /* keep the original chunk if the salvage attempt fails */
        }
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
