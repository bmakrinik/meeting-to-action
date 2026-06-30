# Meet Recordings → Shared Drive auto-mover

A small Google Apps Script each meeting recorder runs in their own account. On a 15-minute
timer it moves new Meet recordings from their personal **My Drive → Meet Recordings** folder
into a central **Shared Drive** folder the transcription app reads.

For the plain-language team rollout (admin steps + per-person steps), see `ROLLOUT.md`.

## Why this exists

Google Meet always saves recordings to the organizer's personal Drive; there's no native
"send recordings to a Shared Drive" setting. This script bridges that gap **without**
domain-wide delegation, so nobody grants broad access to everyone's Drive, each person's
script moves only their own recordings. It uses the built-in **DriveApp** service, so there
is no Cloud project or API to enable.

## Setup (per recorder, ~3 minutes)

Prerequisite (admin, once): a Shared Drive with a recordings folder, the service account
added as **Content manager**, and each recorder added as **Contributor**. Have the
recordings folder's id ready (the last path segment of the folder's Drive URL).

1. https://script.google.com → **New project**.
2. Replace `Code.gs` with this folder's `Code.gs`, then set `SHARED_DRIVE_FOLDER_ID` at the
   top to your recordings folder id.
3. Project Settings → tick **"Show appsscript.json manifest file"** → replace
   `appsscript.json` with this folder's version.
4. Save both. Select `setup` → **Run** → approve the Drive prompt.
5. Execution log should show `Trigger created...` / `Done.`

## Behavior

- **Backlog guard.** `setup` stamps an install time; only recordings created *after* that
  are moved. Existing history stays put (logged as `skippedOld`).
- **Finalization guard.** Files newer than `MIN_AGE_MINUTES` (default 10) are skipped so a
  recording still being written isn't moved mid-flush.
- **Idempotent.** A moved file leaves "Meet Recordings", so it's never seen again.
- **Ownership.** Moving into a Shared Drive transfers ownership to that drive. The recording
  leaves the organizer's My Drive. To keep a personal copy, switch the move to a copy.
- **Folder name.** Auto-finds the folder named `Meet Recordings`. If an account's folder is
  named differently (e.g. localized), set `SOURCE_FOLDER_NAME` accordingly.

## OAuth scopes (in `appsscript.json`)

- `drive` — read the source folder and move files into the Shared Drive (via DriveApp).
- `script.scriptapp` — create the time-based trigger.

## App side

Configure the polled folder(s) in the app under **Settings → Meet Recordings folders**
(supports multiple). The service account must be a member of each Shared Drive.

## What it does NOT do

- Doesn't touch anything other than `video/mp4` files in the Meet Recordings folder.
- Doesn't give anyone access to other people's Drives, each script runs as its own user.
