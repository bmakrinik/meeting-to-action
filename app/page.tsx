"use client";

import { useEffect, useState } from "react";

interface ActionItem {
  owner: string | null;
  task: string;
  due: string | null;
  evidence: string | null;
}
interface Poll {
  id: number;
  ranAt: string;
  trigger: "cron" | "manual";
  found: number;
  succeeded: number;
  failed: number;
  error: string | null;
}
interface Status {
  cronEnabled: boolean;
  pollIntervalMinutes: number;
  polls: Poll[];
}

function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
interface Meeting {
  id: number;
  fileName: string;
  status: string;
  error: string | null;
  summary: string | null;
  transcript: string | null;
  rawTranscript: string | null;
  notionUrl: string | null;
  meetingTime: string | null;
  attendees: string[];
  unmappedSpeakers: string[];
  transcribeModel: string | null;
  postprocessModel: string | null;
  startedAt: string;
  finishedAt: string | null;
  actionItems: ActionItem[];
}

export default function Dashboard() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [showRaw, setShowRaw] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [showPolls, setShowPolls] = useState(false);

  async function load() {
    const [m, s] = await Promise.all([
      fetch("/api/meetings", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/status", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setMeetings(m);
    setStatus(s);
  }

  useEffect(() => {
    load();
    // Auto-refresh so cron activity and run outcomes appear without a manual reload.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function runNow() {
    setBusy(true);
    flash("Processing new files...");
    try {
      const res = await fetch("/api/run", { method: "POST" });
      const data = await res.json();
      if (!data.ok) flash(`Poll error: ${data.poll?.error || "failed"}`);
      else {
        const p = data.poll;
        flash(
          p.found === 0
            ? "Done. No new files."
            : `Done. ${p.found} found, ${p.succeeded} ok, ${p.failed} failed.`
        );
      }
      await load();
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function rerun(id: number) {
    setBusy(true);
    flash(`Re-running meeting #${id}...`);
    try {
      const res = await fetch(`/api/rerun/${id}`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) flash(`Error: ${data.error}`);
      else flash("Re-run complete.");
      await load();
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 18 }}>
        <div>
          <h2 style={{ margin: 0 }}>Meetings</h2>
          <div className="muted small">
            Polls Google Drive for new Meet recordings, transcribes, and writes to Notion.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="secondary" onClick={load} disabled={busy}>
            Refresh
          </button>
          <button onClick={runNow} disabled={busy}>
            {busy ? "Working..." : "Run now"}
          </button>
        </div>
      </div>

      {status && (
        <div className="card">
          <div className="row">
            <div>
              <span
                className={`badge ${status.cronEnabled ? "success" : "failed"}`}
              >
                Auto-poll {status.cronEnabled ? "ON" : "OFF"}
              </span>
              <span className="muted small" style={{ marginLeft: 10 }}>
                {status.cronEnabled
                  ? `every ${status.pollIntervalMinutes} min`
                  : "enable in Settings to poll automatically"}
              </span>
            </div>
            <div className="small muted">
              {(() => {
                const last = status.polls[0];
                if (!last) return "no polls yet";
                if (last.error)
                  return (
                    <span style={{ color: "var(--red)" }}>
                      last poll {relTime(last.ranAt)}: error
                    </span>
                  );
                return `last poll ${relTime(last.ranAt)}: ${last.found} found, ${last.succeeded} ok, ${last.failed} failed`;
              })()}
            </div>
          </div>

          {status.polls.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button
                className="secondary small"
                onClick={() => setShowPolls((v) => !v)}
              >
                {showPolls ? "Hide" : "Show"} poll history
              </button>
              {showPolls && (
                <div style={{ marginTop: 8 }}>
                  {status.polls.map((p) => (
                    <div
                      key={p.id}
                      className="small"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "3px 0",
                        borderBottom: "1px solid var(--border)",
                        color: p.error || p.failed > 0 ? "var(--red)" : undefined,
                      }}
                    >
                      <span>
                        {relTime(p.ranAt)} · {p.trigger}
                      </span>
                      <span>
                        {p.error
                          ? `error: ${p.error}`
                          : `${p.found} found, ${p.succeeded} ok, ${p.failed} failed`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {meetings.length === 0 && (
        <div className="card muted">
          No runs yet. Drop a test MP4 in your fixture/Drive folder and click <b>Run now</b>.
        </div>
      )}

      {meetings.map((m) => (
        <div className="card" key={m.id}>
          <div className="row">
            <div>
              <div style={{ fontWeight: 600 }}>{m.fileName}</div>
              <div className="kv">
                {m.meetingTime
                  ? `meeting ${new Date(m.meetingTime).toLocaleString()}`
                  : `started ${new Date(m.startedAt).toLocaleString()}`}{" "}
                · #{m.id} · <span className="mono">{m.transcribeModel}</span>
              </div>
              {m.attendees.length > 0 && (
                <div className="kv">Attendees: {m.attendees.join(", ")}</div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`badge ${m.status}`}>{m.status}</span>
              {m.notionUrl && (
                <a href={m.notionUrl} target="_blank" rel="noreferrer">
                  Notion ↗
                </a>
              )}
              <button className="secondary" onClick={() => rerun(m.id)} disabled={busy}>
                Re-run
              </button>
            </div>
          </div>

          {m.error && (
            <div
              className="small"
              style={{
                color: m.status === "failed" ? "var(--red)" : "var(--muted)",
                marginTop: 8,
              }}
            >
              {m.error}
            </div>
          )}

          {m.actionItems.length > 0 && (
            <ul className="items">
              {m.actionItems.map((a, i) => (
                <li key={i}>
                  <b>{a.owner || "unassigned"}</b>: {a.task}
                  {a.due ? <span className="muted"> (due {a.due})</span> : null}
                </li>
              ))}
            </ul>
          )}

          {(m.summary || m.transcript) && (
            <div style={{ marginTop: 10 }}>
              <button
                className="secondary small"
                onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
              >
                {open[m.id] ? "Hide" : "Show"} summary & transcript
              </button>
              {open[m.id] && (
                <>
                  {m.rawTranscript && (
                    <button
                      className="secondary small"
                      style={{ marginLeft: 8 }}
                      onClick={() =>
                        setShowRaw((r) => ({ ...r, [m.id]: !r[m.id] }))
                      }
                    >
                      {showRaw[m.id] ? "Show cleaned" : "Show raw"}
                    </button>
                  )}
                  <div className="transcript small">
                    {m.summary ? `SUMMARY\n${m.summary}\n\n` : ""}
                    {showRaw[m.id]
                      ? m.rawTranscript
                        ? `RAW TRANSCRIPT\n${m.rawTranscript}`
                        : ""
                      : m.transcript
                      ? `TRANSCRIPT\n${m.transcript}`
                      : ""}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
