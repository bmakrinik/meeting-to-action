"use client";

import { useEffect, useState } from "react";

interface Speaker { name: string; hint?: string }
interface Glossary { wrong: string; right: string }
interface TeamMember { name: string; role?: string }
interface Settings {
  transcribeModel: string;
  postprocessModel: string;
  language: string;
  pollIntervalMinutes: number;
  cronEnabled: boolean;
  enrolledSpeakers: Speaker[];
  glossary: Glossary[];
  teamRoster: TeamMember[];
  notionDatabaseId: string;
  meetRecordingsFolderId: string;
  meetRecordingsFolderIds: string[];
  deleteRecordingAfterProcessing: boolean;
  videoRetentionDays: number;
}

const MODEL_SUGGESTIONS = [
  "gpt-4o-transcribe-diarize",
  "gpt-4o-transcribe",
  "whisper-1",
];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [customModel, setCustomModel] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: Settings) => {
        // Consolidate the legacy single folder field into the list for editing.
        const ids = data.meetRecordingsFolderIds?.length
          ? data.meetRecordingsFolderIds
          : data.meetRecordingsFolderId
          ? [data.meetRecordingsFolderId]
          : [];
        setS({ ...data, meetRecordingsFolderIds: ids, meetRecordingsFolderId: "" });
      });
  }, []);

  if (!s) return <div className="container">Loading…</div>;

  function up<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  async function save() {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    setS(await res.json());
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="container">
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Models</h3>
        <div className="grid2">
          <div className="field">
            <label>Transcription model (swappable)</label>
            <select
              value={customModel ? "__custom__" : s.transcribeModel}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setCustomModel(true);
                } else {
                  setCustomModel(false);
                  up("transcribeModel", e.target.value);
                }
              }}
            >
              {Array.from(
                new Set([...MODEL_SUGGESTIONS, s.transcribeModel])
              )
                .filter(Boolean)
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              <option value="__custom__">Custom…</option>
            </select>
            {customModel && (
              <input
                style={{ marginTop: 8 }}
                placeholder="enter a model id"
                value={s.transcribeModel}
                onChange={(e) => up("transcribeModel", e.target.value)}
              />
            )}
            <div className="muted small">
              Diarize models give speaker labels; plain models (e.g.
              gpt-4o-transcribe) need content inference.
            </div>
          </div>
          <div className="field">
            <label>Post-processing model</label>
            <input
              value={s.postprocessModel}
              onChange={(e) => up("postprocessModel", e.target.value)}
            />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Language hint</label>
            <input value={s.language} onChange={(e) => up("language", e.target.value)} />
          </div>
          <div className="field">
            <label>Notion database ID</label>
            <input
              value={s.notionDatabaseId}
              onChange={(e) => up("notionDatabaseId", e.target.value)}
              placeholder="overrides NOTION_DATABASE_ID env"
            />
          </div>
          <div className="field">
            <label>Meet Recordings folders (Shared Drive) — one or more</label>
            {s.meetRecordingsFolderIds.map((id, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}
              >
                <input
                  style={{ flex: 1 }}
                  placeholder="Drive folder ID"
                  value={id}
                  onChange={(e) => {
                    const next = [...s.meetRecordingsFolderIds];
                    next[i] = e.target.value;
                    up("meetRecordingsFolderIds", next);
                  }}
                />
                <button
                  className="secondary"
                  onClick={() =>
                    up(
                      "meetRecordingsFolderIds",
                      s.meetRecordingsFolderIds.filter((_, j) => j !== i)
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="secondary"
              onClick={() =>
                up("meetRecordingsFolderIds", [...s.meetRecordingsFolderIds, ""])
              }
            >
              + Add folder
            </button>
            <div className="muted small" style={{ marginTop: 6 }}>
              Each Shared Drive folder the app polls for recordings. The service account
              must be a member of each Shared Drive.
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Polling</h3>
        <div className="grid2">
          <div className="field">
            <label>Poll interval (minutes)</label>
            <input
              type="number"
              min={1}
              max={59}
              value={s.pollIntervalMinutes}
              onChange={(e) => up("pollIntervalMinutes", Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>Auto-poll enabled</label>
            <select
              value={s.cronEnabled ? "yes" : "no"}
              onChange={(e) => up("cronEnabled", e.target.value === "yes")}
            >
              <option value="no">No (manual Run now only)</option>
              <option value="yes">Yes (cron)</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>Delete recording from Drive after processing</label>
          <select
            value={s.deleteRecordingAfterProcessing ? "yes" : "no"}
            onChange={(e) =>
              up("deleteRecordingAfterProcessing", e.target.value === "yes")
            }
          >
            <option value="no">No (keep the MP4 in Drive)</option>
            <option value="yes">Yes (trash the MP4 after Notion write)</option>
          </select>
          <div className="muted small">
            Deleting requires the Drive service account to have Editor access. Leave off
            to keep recordings and avoid permission errors.
          </div>
        </div>
        <div className="field">
          <label>Keep video for (days), then replace with audio</label>
          <input
            type="number"
            min={0}
            value={s.videoRetentionDays}
            onChange={(e) => up("videoRetentionDays", Number(e.target.value))}
          />
          <div className="muted small">
            After this many days the original video is trashed, a small audio copy is kept
            in the Shared Drive on processing. 0 disables the sweep (videos kept). Requires
            the service account to have Editor access.
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Enrolled speakers (max 4 for diarization)</h3>
        <div className="muted small" style={{ marginBottom: 10 }}>
          People likely in meetings. Unmatched speakers stay labeled "Speaker N" and are
          flagged on the dashboard rather than guessed.
        </div>
        {s.enrolledSpeakers.map((sp, i) => (
          <div className="repeatable-row" key={i}>
            <input
              placeholder="Name"
              value={sp.name}
              onChange={(e) => {
                const next = [...s.enrolledSpeakers];
                next[i] = { ...next[i], name: e.target.value };
                up("enrolledSpeakers", next);
              }}
            />
            <input
              placeholder="Hint (role/voice)"
              value={sp.hint || ""}
              onChange={(e) => {
                const next = [...s.enrolledSpeakers];
                next[i] = { ...next[i], hint: e.target.value };
                up("enrolledSpeakers", next);
              }}
            />
            <button
              className="secondary"
              onClick={() =>
                up(
                  "enrolledSpeakers",
                  s.enrolledSpeakers.filter((_, j) => j !== i)
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="secondary"
          disabled={s.enrolledSpeakers.length >= 4}
          onClick={() => up("enrolledSpeakers", [...s.enrolledSpeakers, { name: "" }])}
        >
          + Add speaker
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Glossary (fix mis-transcribed terms)</h3>
        {s.glossary.map((g, i) => (
          <div className="repeatable-row" key={i}>
            <input
              placeholder="Heard as…"
              value={g.wrong}
              onChange={(e) => {
                const next = [...s.glossary];
                next[i] = { ...next[i], wrong: e.target.value };
                up("glossary", next);
              }}
            />
            <input
              placeholder="Correct term"
              value={g.right}
              onChange={(e) => {
                const next = [...s.glossary];
                next[i] = { ...next[i], right: e.target.value };
                up("glossary", next);
              }}
            />
            <button
              className="secondary"
              onClick={() => up("glossary", s.glossary.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="secondary"
          onClick={() => up("glossary", [...s.glossary, { wrong: "", right: "" }])}
        >
          + Add term
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Team roster (resolve action-item owners)</h3>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Company members used to attribute action items to real people. Owners are only
          assigned when the transcript supports it; otherwise they stay unassigned.
        </div>
        {s.teamRoster.map((m, i) => (
          <div className="repeatable-row" key={i}>
            <input
              placeholder="Name"
              value={m.name}
              onChange={(e) => {
                const next = [...s.teamRoster];
                next[i] = { ...next[i], name: e.target.value };
                up("teamRoster", next);
              }}
            />
            <input
              placeholder="Role (optional)"
              value={m.role || ""}
              onChange={(e) => {
                const next = [...s.teamRoster];
                next[i] = { ...next[i], role: e.target.value };
                up("teamRoster", next);
              }}
            />
            <button
              className="secondary"
              onClick={() => up("teamRoster", s.teamRoster.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="secondary"
          onClick={() => up("teamRoster", [...s.teamRoster, { name: "", role: "" }])}
        >
          + Add member
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={save}>Save settings</button>
        {saved && <span className="muted small">Saved.</span>}
      </div>
    </div>
  );
}
