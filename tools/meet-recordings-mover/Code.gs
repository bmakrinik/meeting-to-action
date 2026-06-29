/**
 * Meet Recordings -> Shared Drive auto-mover (per-user Apps Script).
 *
 * Each meeting organizer runs this in their own Google account. On a 15-minute trigger it
 * moves new Meet recordings from their personal "Meet Recordings" folder into a central
 * Shared Drive folder, so the transcription app can read every meeting from one place,
 * without domain-wide delegation or access to anyone else's Drive.
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
