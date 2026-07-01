# Meeting to Action

Turn Google Meet recordings into a clean transcript, a structured summary, and
owner-tagged action items, written to a Notion database, one page per meeting.

A small Next.js app polls a Google Drive folder for new recordings, extracts the audio,
transcribes it with OpenAI, post-processes it into a summary + action items, and writes the
result to Notion. It works for meetings in any language (including mixed-language meetings).

It accepts both Google Meet `.mp4` recordings and standalone audio files
(`.mp3`, `.m4a`, `.wav`, `.aac`, `.flac`, `.ogg`, `.opus`, `.webm`) — drop either into the
recordings folder. Audio files are transcribed directly (ffmpeg just normalizes them);
since an audio file is already small, the video-retention step below is skipped for it.

## How it works

```
Drive folder (new .mp4 or audio file)
   -> download -> ffmpeg audio (chunked) -> OpenAI transcription
   -> OpenAI post-processing (clean transcript + summary + action items + attendees)
   -> Notion page  (+ for videos: keep a small audio copy, trash the video after N days)
```

- **Transcription:** OpenAI `gpt-4o-transcribe` (swappable in Settings; a diarizing model is
  also supported).
- **Post-processing:** OpenAI `gpt-4o` for a sectioned summary and evidence-grounded,
  owner-tagged action items.
- **Notion:** the writer is schema-adaptive, it sets whichever properties your database has
  (title, date, attendees, host, status, etc.) and puts the full transcript in the page body.
- **Storage:** keeps a small audio copy in Drive and trashes the original video after a
  configurable retention window.

## Requirements

- Node 20+
- `ffmpeg` on the PATH (used to extract audio)
- An OpenAI API key
- A Notion integration token + a database to write to
- (For real Drive polling) a Google service-account or OAuth credential with Drive access,
  and a Drive folder id. You can skip this and test with local files (see below).

## Setup

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev                        # http://localhost:3000
```

Key environment variables (see `.env.local.example`):

- `OPENAI_API_KEY`
- `NOTION_TOKEN`, `NOTION_DATABASE_ID` (share the database with your integration)
- `GOOGLE_CREDENTIALS_PATH`, `MEET_RECORDINGS_FOLDER_ID` for Drive polling
- `LOCAL_FIXTURE_DIR` to read `.mp4` or audio files from a local folder instead of Drive
  (handy for testing without Google credentials)
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` to put the app behind HTTP Basic Auth (optional)

The recordings folder(s) can also be set in the app's **Settings** UI, which supports
multiple folders.

## Using it

- **Dashboard** (`/`): run history, status, action items, and a poll-status banner. "Run now"
  processes new files immediately; "Re-run" reprocesses a meeting.
- **Settings** (`/settings`): models, language hint, recordings folders, glossary, team
  roster (improves owner/attendee resolution), poll interval and auto-poll, and the video
  retention window.

## Getting recordings into the folder

Google Meet saves each recording to the organizer's personal Drive, not a shared location.
`tools/meet-recordings-mover/` contains a small per-user Google Apps Script that moves a
person's new Meet recordings into the shared folder the app reads, no domain-wide
delegation required. See that folder's `README.md`.

## Deploy

A `Dockerfile` is included. The app keeps state in a small SQLite file under `data/` and
runs an in-process poller, so run it as a **single instance** with a persistent volume
mounted at `/app/data`. Provide the same environment variables as above. Any container host
works.

## License

MIT, see `LICENSE`.
