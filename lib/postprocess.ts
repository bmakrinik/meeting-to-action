import OpenAI from "openai";
import type { AppSettings } from "./settings";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set.");
  _client = new OpenAI({ apiKey });
  return _client;
}

export interface ActionItem {
  owner: string | null; // real name if confidently identifiable, else null
  task: string;
  due: string | null;
  evidence: string | null; // verbatim transcript quote proving the commitment
}

export interface PostProcessResult {
  summary: string;
  rawTranscript: string; // verbatim from transcription, never sent back through the LLM as output
  cleanedTranscript: string; // readable: punctuation, paragraphs, glossary fixes, filler removed
  actionItems: ActionItem[];
  attendees: string[]; // participant names inferred from the transcript + roster
  host: string | null; // the person who led/organized the meeting, if identifiable
  unmappedSpeakers: string[]; // diarizer labels (e.g. "Speaker 2") not matched to a person
}

// Clean the transcript in chunks so a long meeting can never exceed the model's output
// limit (which would silently truncate the middle). ~6000 chars in -> well under 4096 tokens out.
const CLEAN_CHUNK_CHARS = 6000;

function glossaryText(settings: AppSettings): string {
  return (
    settings.glossary.map((g) => `- "${g.wrong}" -> "${g.right}"`).join("\n") ||
    "(none provided)"
  );
}

// Correct domain terms / proper nouns the transcriber tends to mangle: the configured
// vocabulary plus the team roster names. The LLM uses these to fix garbled mentions
// dynamically (no need to enumerate every wrong spelling).
function knownTermsText(settings: AppSettings): string {
  const terms = [
    ...settings.vocabulary,
    ...settings.teamRoster.map((m) => m.name),
  ]
    .map((t) => (t || "").trim())
    .filter(Boolean);
  return Array.from(new Set(terms)).join(", ") || "(none provided)";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Deterministic exact replacements from the glossary, applied verbatim (the LLM pass is
// inconsistent at catching every instance, this guarantees them).
function applyGlossary(text: string, settings: AppSettings): string {
  let t = text;
  for (const g of settings.glossary) {
    if (!g.wrong || !g.right) continue;
    t = t.replace(new RegExp(escapeRe(g.wrong), "gi"), g.right);
  }
  return t;
}

// Deterministic filler removal for the high-frequency verbal tics the LLM tends to leave behind.
function stripFillers(text: string): string {
  let t = text;
  // comma-bounded discourse markers -> collapse to a single comma
  t = t.replace(/,\s*(you know|i mean|sort of|kind of)\s*,/gi, ", ");
  // sentence-leading marker + comma -> drop
  t = t.replace(/(^|[.!?;]\s+)(you know|i mean|well)\s*,\s*/gi, "$1");
  // filler interjections
  t = t.replace(/\s*(?<!\p{L})(um+|uh+|erm+|hmm+)(?!\p{L})/giu, "");
  // tidy whitespace + punctuation
  t = t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/(^|\n)[ ,]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n");
  return t;
}

function splitForCleaning(text: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CLEAN_CHUNK_CHARS, text.length);
    if (end < text.length) {
      // Prefer to break on a sentence boundary so we don't cut mid-thought.
      const dot = text.lastIndexOf(". ", end);
      if (dot > i + 1000) end = dot + 1;
    }
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts.length ? parts : [""];
}

const CLEAN_SYSTEM = `You clean raw speech-to-text transcripts of meetings. A transcript may be in any language or mix languages.
Rules:
- Preserve ALL real meaning and content. Do NOT summarize, drop, or add real information.
- Fix punctuation and capitalization, and split the text into readable paragraphs.
- Remove filler words and verbal tics. Delete discourse markers like "um", "uh", "you know",
  "like", "I mean", "sort of" (and their equivalents in other languages) wherever they add
  nothing, and drop repeated restarts of the same phrase. Removing a filler must never change
  the meaning of the surrounding sentence (re-join the remaining words cleanly).
- Drop speech-to-text HALLUCINATIONS: segments the model invented that are not real speech.
  Remove obvious mic-check / setup chatter and nonsensical off-topic lines at the very start
  or end (silence often produces fabricated text like "testing, testing"). Only remove text
  you are confident is a fabrication; never remove real discussion, and never translate, just
  delete the artifact.
- Keep each part of the transcript in its original language; do not translate.
- Fix garbled speech-to-text tokens, including non-words. You only have the text, so when a
  token is not a real word, SOUND IT OUT phonetically and infer the intended word from how it
  sounds plus the surrounding context. A token transcribed in one script may be a phonetic
  mis-hearing of a word (often an English/technical term) in another, so consider that and
  restore the word in its correct language and spelling. LEAN TOWARD FIXING clear gibberish to
  the most likely intended word, but do NOT paraphrase or "improve" words that are already
  valid, and never invent content that wasn't said.
- KNOWN TERMS AND NAMES (correct spellings): {KNOWN_TERMS}.
  Match tokens against this list phonetically and replace a clear phonetic mangling of a known
  product/person with the correct spelling above. Do not force unrelated words onto this list.
- If a line is prefixed with "Speaker N:" or a person's name, keep that label.
- Apply this glossary of corrections where the term appears:
{GLOSSARY}
Return ONLY the cleaned transcript text, with no preamble or commentary.`;

async function cleanChunk(
  chunk: string,
  glossary: string,
  knownTerms: string,
  model: string
): Promise<string> {
  const system = CLEAN_SYSTEM.replace("{GLOSSARY}", glossary).replace(
    "{KNOWN_TERMS}",
    knownTerms
  );
  const resp = await client().chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: chunk },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || chunk;
}

const ANALYSIS_SYSTEM = `You analyze meeting transcripts. A transcript may be in any language or mix languages.
Return STRICT JSON only with keys: { "summary", "actionItems", "attendees", "host", "unmappedSpeakers" }.

GROUNDING RULES (critical):
- Every action item MUST include a verbatim "evidence" quote copied EXACTLY from the transcript
  (the words that show the commitment). If you cannot find a real supporting quote, do not include
  the item. Never paraphrase the evidence and never invent it.
- Resolve owners to real people using the TEAM ROSTER and ENROLLED SPEAKERS provided. Use a name
  only when the transcript supports it (the person volunteers, is assigned, or is addressed by name);
  otherwise owner = null. Never guess an owner.
- Keep every quote in its original language; do not translate.
- Use the KNOWN TERMS AND NAMES list to recognize garbled transcriptions: a phonetic
  mangling of a known product name or person should be understood as that term/person
  (e.g. when matching an owner or naming a topic). Do not invent matches.

summary: an OBJECT with three arrays of short strings that describe WHAT HAPPENED
(never things to be done):
  { "decisions": [], "discussion": [], "openQuestions": [] }
  - decisions: concrete decisions made.
  - discussion: the topics and themes discussed, each phrased as a short TOPIC (a noun
    phrase), not a sentence about who will do what. Good: "Adversarial verification in
    coding", "Automating bug resolution". Never use future tense and never write a
    person's name followed by a task here.
  - openQuestions: unresolved questions or disagreements.
  Use [] for any section with nothing to report.
  STRICT SEPARATION: the summary describes the discussion; actionItems list what people
  will DO. Never put a task, assignment, commitment, or "X will ..." statement in the
  summary, and never restate an action item there. If something is an action item, it
  MUST NOT also appear in discussion.

actionItems: extract EVERY follow-up, task, or commitment, including soft ones
("I'll clean up X", "we should review Y", "let's do Z next week", "X will take care of ..."). Be thorough;
returning an empty list when the meeting clearly has next steps is a mistake. But never invent items.
  Each item: { "owner", "task", "due", "evidence" }
    - owner: real person from the roster/transcript, else null.
    - task: the action, phrased clearly in English.
    - due: ISO date or short phrase if stated (e.g. "Friday"), else null.
    - evidence: exact verbatim quote from the transcript that proves this commitment.

attendees: the people who took part in this meeting, identified from the transcript and the
team roster (names spoken, self-introductions, people clearly speaking or being addressed).
Use real names from the roster when supported. [] if you genuinely cannot tell.

host: the single person who organized or led the meeting (set the agenda, drove the
discussion, called on others), as a real roster name. null if it is not clear.

unmappedSpeakers: diarizer labels (e.g. "Speaker 2") you could not match to a real person; [] if none.

EXAMPLES (transcript snippet -> actionItems):

Example 1:
"Alex: I'll send the spec by Friday. Sam: Great, and Dana should review it after."
[
  {"owner":"Alex","task":"Send the spec","due":"Friday","evidence":"I'll send the spec by Friday"},
  {"owner":"Dana","task":"Review the spec once sent","due":null,"evidence":"Dana should review it after"}
]

Example 2 (quotes stay verbatim, in whatever language they were spoken):
"Sam: I'll set up the staging deploy this week. Someone needs to write tests too."
[
  {"owner":"Sam","task":"Set up the staging deploy","due":"this week","evidence":"I'll set up the staging deploy this week"},
  {"owner":null,"task":"Write tests","due":null,"evidence":"Someone needs to write tests too"}
]

Example 3 (no commitments):
"We just reviewed last quarter's numbers and chatted a bit."
[]

Example 4 (summary topics vs action items must NOT overlap):
"We discussed how to automate bug resolution. Kim took on building a prototype."
summary.discussion: ["Automating bug resolution"]
actionItems: [{"owner":"Kim","task":"Build a bug-resolution prototype","due":null,"evidence":"Kim took on building a prototype"}]
(Note: the discussion entry is a topic; the assignment lives only in actionItems.)`;

// Render the structured summary object into readable sectioned text for storage/Notion/UI.
function renderSummary(s: any): string {
  if (typeof s === "string") return s; // model returned prose despite instructions
  const section = (title: string, arr: any): string | null =>
    Array.isArray(arr) && arr.length
      ? `${title}:\n` + arr.map((x: any) => `- ${String(x)}`).join("\n")
      : null;
  return [
    section("Decisions", s?.decisions),
    section("Discussion", s?.discussion),
    section("Open questions", s?.openQuestions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function analyze(
  transcript: string,
  glossary: string,
  speakers: string,
  roster: string,
  knownTerms: string,
  model: string
): Promise<{
  summary: string;
  actionItems: ActionItem[];
  attendees: string[];
  host: string | null;
  unmappedSpeakers: string[];
}> {
  const user =
    `KNOWN TERMS AND NAMES (correct spellings; map garbled mentions to these):\n${knownTerms}\n\n` +
    `GLOSSARY (wrong -> right):\n${glossary}\n\n` +
    `TEAM ROSTER (resolve owners to these people when supported):\n${roster || "(none provided)"}\n\n` +
    `ENROLLED SPEAKERS (likely in this meeting):\n${speakers || "(none provided)"}\n\n` +
    `TRANSCRIPT:\n${transcript}`;

  const resp = await client().chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: ANALYSIS_SYSTEM },
      { role: "user", content: user },
    ],
  });

  let parsed: any = {};
  try {
    parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
  } catch {
    parsed = {};
  }
  return {
    summary: renderSummary(parsed.summary),
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems
          .map((a: any) => ({
            owner: a.owner ?? null,
            task: String(a.task || "").trim(),
            due: a.due ?? null,
            evidence: a.evidence ? String(a.evidence) : null,
          }))
          .filter((a: ActionItem) => a.task.length > 0)
      : [],
    attendees: Array.isArray(parsed.attendees)
      ? parsed.attendees.map((a: any) => String(a)).filter((a: string) => a.trim())
      : [],
    host: parsed.host ? String(parsed.host) : null,
    unmappedSpeakers: Array.isArray(parsed.unmappedSpeakers)
      ? parsed.unmappedSpeakers.map((s: any) => String(s))
      : [],
  };
}

export async function run(
  transcript: string,
  settings: AppSettings
): Promise<PostProcessResult> {
  const glossary = glossaryText(settings);
  const knownTerms = knownTermsText(settings);
  const speakers = settings.enrolledSpeakers
    .map((s) => `- ${s.name}${s.hint ? ` (${s.hint})` : ""}`)
    .join("\n");
  const roster = settings.teamRoster
    .map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`)
    .join("\n");

  // Analysis runs on the full raw transcript (small JSON output, no truncation risk).
  const analysis = await analyze(
    transcript,
    glossary,
    speakers,
    roster,
    knownTerms,
    settings.postprocessModel
  );

  // Cleaning runs chunk-by-chunk and is concatenated, so length is unbounded.
  const chunks = splitForCleaning(transcript);
  const cleanedParts: string[] = [];
  for (const c of chunks) {
    cleanedParts.push(await cleanChunk(c, glossary, knownTerms, settings.postprocessModel));
  }
  // Deterministic post-pass: guarantee exact glossary replacements and filler removal that
  // the LLM applies only inconsistently across a long transcript.
  const cleanedTranscript = stripFillers(applyGlossary(cleanedParts.join("\n\n"), settings));

  return {
    summary: analysis.summary,
    rawTranscript: transcript,
    cleanedTranscript,
    actionItems: analysis.actionItems,
    attendees: analysis.attendees,
    host: analysis.host,
    unmappedSpeakers: analysis.unmappedSpeakers,
  };
}
