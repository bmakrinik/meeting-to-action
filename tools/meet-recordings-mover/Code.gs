/**
 * Meet Recordings -> Shared Drive auto-mover (per-user Apps Script).
 *
 * Each meeting organizer runs this in their own Google account. On a 15-minute trigger it
 * moves new Meet recordings from their personal "Meet Recordings" folder into the central
 * Shared Drive folder, so the transcription app can read every meeting from one
 * place, without domain-wide delegation or access to anyone else's Drive.
 *
 * Uses the built-in DriveApp service (no Cloud project / API enabling needed).
 * Idempotent: a moved file leaves "Meet Recordings", so it's never seen again. Files
 * younger than MIN_AGE_MINUTES are skipped until they finish finalizing.
 */

// ===== CONFIG: set this to your Shared Drive recordings folder id. =====
const SHARED_DRIVE_FOLDER_ID = 'YOUR_SHARED_DRIVE_FOLDER_ID';
const SOURCE_FOLDER_NAME = 'Meet Recordings';
const MIN_AGE_MINUTES = 10;        // skip files newer than this (may still be writing)
const TRIGGER_EVERY_MINUTES = 15;  // poll cadence created by setup()
const START_PROP = 'moveFilesCreatedAfter'; // only move recordings created after setup time
const CALENDAR_LOOKBACK_HOURS = 8; // search this far back from the recording for its event

/** Main job: move new recordings into the Shared Drive. Runs on the time trigger. */
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
    if (created > cutoff) { skippedRecent++; continue; }   // too new, may still be writing
    if (created < startAfter) { skippedOld++; continue; }   // pre-install backlog: leave it
    try {
      stampCalendarMeta_(f); // attach organizer/guests from the matching calendar event
      f.moveTo(dest); // ownership transfers to the Shared Drive
      moved++;
      Logger.log('Moved: ' + f.getName());
    } catch (e) {
      failed++;
      Logger.log('FAILED to move "' + f.getName() + '": ' + e);
    }
  }

  Logger.log(
    'Done. moved=%s skippedRecent=%s skippedOld=%s failed=%s',
    moved, skippedRecent, skippedOld, failed
  );
}

// Find the calendar event this recording belongs to (on the runner's own calendar) and
// stamp organizer + guests onto the file's description as JSON, so the app gets
// authoritative attendees/host. Best-effort: never blocks the move.
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

    const guests = best.getGuestList(true); // include the owner
    const invited = [];
    const attendees = [];
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

// Strip ".mp4", " - Recording", and a trailing date/time so the name matches the event title.
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

// ===== Run this once from the editor. Creates the timer and does a first run. =====
// Only recordings created AFTER the first setup are moved, so existing history is left alone.
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
