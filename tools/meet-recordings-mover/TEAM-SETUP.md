# Meeting recordings → auto-transcription: 3-minute setup

We automatically transcribe meetings and write summaries + action items to Notion. For
your meetings to be included, do this **one-time, 3-minute** setup. It installs a tiny
script in your Google account that moves your new Meet recordings into our shared folder.

It only ever touches **your own** recordings, and only **new** ones (your past recordings
are left alone). It never reads your documents or anyone else's Drive.

---

## Steps

1. Go to **https://script.google.com** and click **New project**.
2. Delete whatever is in the `Code.gs` file and paste in **Script 1** below.
3. Click the **gear icon (Project Settings)** in the left sidebar, and tick
   **"Show 'appsscript.json' manifest file in the editor."**
4. Click the **`< >` (Editor)** icon to go back. Open the new **`appsscript.json`** file,
   delete its contents, and paste in **Script 2** below.
5. Press **Cmd/Ctrl + S** to save both files.
6. In the toolbar, choose **`setup`** in the function dropdown (next to Run), then click
   **Run**.
7. Approve the permission prompt:
   - Choose your account.
   - On "Google hasn't verified this app": click **Advanced** → **Go to (project) (unsafe)**
     → **Allow**. (It's your own script, this is expected.)
8. Check the **Execution log** at the bottom shows `Trigger created...` and `Done.`

That's it. From now on your new recordings move automatically every 15 minutes and get
transcribed. You can close the tab.

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
      f.moveTo(dest);
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
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

---

## Good to know

- **Only new recordings are moved.** Your existing recording history stays where it is
  (the log shows `skippedOld=N`).
- A recording **leaves your "Meet Recordings" folder** once moved (it now lives in the
  shared drive). Want to keep a personal copy? Tell the product team.
- The script only touches video files in your Meet Recordings folder, never your docs.
- **Privacy:** meetings get transcribed into a shared Notion database others can read. Make
  sure participants know a meeting is recorded and captured. If a meeting shouldn't be
  transcribed, don't record it.

## If recordings stop arriving

- In the Apps Script project, open **Triggers** (clock icon); there should be one
  `moveNewRecordings` trigger. Re-run `setup` if it's missing.
- Confirm you still have access to the shared recordings drive.
