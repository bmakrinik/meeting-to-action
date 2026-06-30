# Meeting recordings → auto-transcription: 3-minute setup

We automatically transcribe meetings and write summaries + action items to Notion. For
your meetings to be included, do this **one-time, 3-minute** setup. It installs a tiny
script in your Google account that moves your new Meet recordings into our shared folder
and tags each one with the meeting's attendees (from your calendar).

It only ever touches **your own** recordings, and only **new** ones (your past recordings
are left alone). It never reads your documents.

> **Already set this up before?** Please redo steps 2-7 with the scripts below, they now
> also read the meeting's calendar event (organizer + guests), so re-running asks for one
> new Calendar permission. Approve it.

---

## Steps

1. Go to **https://script.google.com** and click **New project**.
2. Delete whatever is in the `Code.gs` file and paste in **Script 1** below.
3. Click the **gear icon (Project Settings)** and tick **"Show 'appsscript.json' manifest file in the editor."**
4. Click the **`< >` (Editor)** icon, open **`appsscript.json`**, delete its contents, and paste in **Script 2**.
5. Press **Cmd/Ctrl + S** to save both files.
6. Choose **`setup`** in the function dropdown (next to Run), then click **Run**.
7. Approve the permission prompt (Drive + Calendar):
   - Choose your account.
   - On "Google hasn't verified this app": **Advanced** → **Go to (project) (unsafe)** → **Allow**.
8. Check the **Execution log** shows `Trigger created...` and `Done.`

That's it. New recordings move automatically every 15 minutes and get transcribed.

> Prerequisite: you need access to the shared recordings drive. If step 6 logs a `403` /
> permission error, ask the product team to add you, then re-run `setup`.

---

## Script 1 — paste into `Code.gs`

```javascript
const SHARED_DRIVE_FOLDER_ID = 'YOUR_SHARED_DRIVE_FOLDER_ID';
const SOURCE_FOLDER_NAME = 'Meet Recordings';
const MIN_AGE_MINUTES = 10;
const TRIGGER_EVERY_MINUTES = 15;
const START_PROP = 'moveFilesCreatedAfter';
const CALENDAR_LOOKBACK_HOURS = 8;

function moveNewRecordings() {
  const startAfter = Number(
    PropertiesService.getScriptProperties().getProperty(START_PROP) || '0'
  );
  const dest = DriveApp.getFolderById(SHARED_DRIVE_FOLDER_ID);

  const folders = DriveApp.getFoldersByName(SOURCE_FOLDER_NAME);
  if (!folders.hasNext()) {
    Logger.log('No "%s" folder found in this account; nothing to do.', SOURCE_FOLDER_NAME);
    return;
  }
  const source = folders.next();

  const cutoff = Date.now() - MIN_AGE_MINUTES * 60 * 1000;
  let moved = 0, skippedRecent = 0, skippedOld = 0, failed = 0;

  const files = source.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() !== 'video/mp4') continue;
    const created = f.getDateCreated().getTime();
    if (created > cutoff) { skippedRecent++; continue; }
    if (created < startAfter) { skippedOld++; continue; }
    try {
      stampCalendarMeta_(f);
      f.moveTo(dest);
      moved++;
      Logger.log('Moved: ' + f.getName());
    } catch (e) {
      failed++;
      Logger.log('FAILED to move "' + f.getName() + '": ' + e);
    }
  }

  Logger.log('Done. moved=%s skippedRecent=%s skippedOld=%s failed=%s',
    moved, skippedRecent, skippedOld, failed);
}

// Tag the recording with its calendar event's organizer + guests (best-effort).
function stampCalendarMeta_(f) {
  try {
    const created = f.getDateCreated();
    const start = new Date(created.getTime() - CALENDAR_LOOKBACK_HOURS * 60 * 60 * 1000);
    const want = normalizeTitle_(cleanTitle_(f.getName()));
    if (!want) return;

    const events = CalendarApp.getEvents(start, created);
    let best = null;
    for (let i = 0; i < events.length; i++) {
      const nt = normalizeTitle_(events[i].getTitle() || '');
      if (!nt) continue;
      if (nt === want || nt.indexOf(want) >= 0 || want.indexOf(nt) >= 0) {
        if (!best || events[i].getStartTime() > best.getStartTime()) best = events[i];
      }
    }
    if (!best) return;

    const guests = best.getGuestList(true);
    const invited = [], attendees = [];
    for (let j = 0; j < guests.length; j++) {
      const g = guests[j];
      invited.push(g.getEmail());
      const s = g.getGuestStatus();
      if (s === CalendarApp.GuestStatus.YES || s === CalendarApp.GuestStatus.OWNER) {
        attendees.push(g.getEmail());
      }
    }
    const organizer = (best.getCreators() && best.getCreators()[0]) || null;
    f.setDescription(JSON.stringify({ organizer: organizer, invited: invited, attendees: attendees }));
    Logger.log('Tagged "%s" from event "%s" (%s invited, %s accepted)',
      f.getName(), best.getTitle(), invited.length, attendees.length);
  } catch (e) {
    Logger.log('Calendar lookup failed for "%s": %s', f.getName(), e);
  }
}

function cleanTitle_(name) {
  return name
    .replace(/\.mp4$/i, '')
    .replace(/\s*-\s*recording\s*$/i, '')
    .replace(/\s*[-–]\s*\d{4}[\/_.-]\d{2}[\/_.-]\d{2}[ T_]+\d{2}[:_.]\d{2}(?::\d{2})?(?:\s*[A-Za-z]{2,5})?\s*$/, '')
    .trim();
}

function normalizeTitle_(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(START_PROP)) props.setProperty(START_PROP, String(Date.now()));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'moveNewRecordings') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('moveNewRecordings')
    .timeBased()
    .everyMinutes(TRIGGER_EVERY_MINUTES)
    .create();
  Logger.log('Trigger created; only recordings created after now will be moved.');
  moveNewRecordings();
}
```

---

## Script 2 — paste into `appsscript.json`

```json
{
  "timeZone": "Etc/UTC",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/calendar.readonly"
  ]
}
```

---

## Good to know

- **Only new recordings are moved.** Your existing recording history stays where it is.
- It reads the **matching calendar event** to fill in the meeting's host and attendees in
  Notion. Calendar access is read-only, and the script only reads your own calendar. Meetings
  with no calendar event (ad-hoc Meets) still work; they just won't have a guest list.
- A recording **leaves your "Meet Recordings" folder** once moved (it now lives in the
  shared drive). Want to keep a personal copy? Tell the product team.
- **Privacy:** meetings get transcribed into a shared Notion database others can read. Make
  sure participants know a meeting is recorded and captured. If a meeting shouldn't be
  transcribed, don't record it.

## If recordings stop arriving

- In the Apps Script project, open **Triggers** (clock icon); there should be one
  `moveNewRecordings` trigger. Re-run `setup` if it's missing.
- Confirm you still have access to the shared recordings drive.
