# Rolling out meeting capture to the team

This explains how we collect everyone's Google Meet recordings into one place so they get
transcribed automatically. It has two parts: a one-time admin setup, and a three-minute
step each person who records meetings does once.

## Why this exists

Google Meet saves each recording to the personal Drive of whoever started the recording.
There is no company-wide folder. So every recorder runs a tiny script that moves their new
recordings into one shared folder, and the transcription app reads that folder. Nobody gets
access to anyone else's Drive, each person's script only ever touches their own recordings.

## Part 1: One-time setup (admin)

1. Create (or pick) a **Shared Drive** and add a folder inside it for recordings.
2. Add the transcription service account
   `your-service-account@your-project.iam.gserviceaccount.com` as a **Content
   manager** of the Shared Drive (Content manager, not viewer, so it can read, save the
   audio copy, and clean up old videos).
3. Add each meeting recorder as a **Contributor** on the Shared Drive so their script can
   move files in.
4. Point the app at the folder: in the app's **Settings → Meet Recordings folders**, add
   the folder's ID and Save. You can add **multiple** folders here; the app polls all of
   them. (No cluster/secret edit needed.)

## Part 2: Per-recorder setup (each person, ~3 minutes, once)

Anyone who records meetings does this once. New hires do it during onboarding.
**Already set this up before?** Redo it with the current files, the script now also reads
the meeting's calendar event, so re-running asks for one new Calendar permission.

1. Go to https://script.google.com → **New project**.
2. Replace the default `Code.gs` with this folder's `Code.gs`. (The target folder is
   already filled in, nothing to edit.)
3. Open **Project Settings** (gear icon) → tick **"Show appsscript.json manifest file"**,
   then replace `appsscript.json` with this folder's version.
4. Save both files. Select **`setup`** in the function dropdown → **Run**.
   - Approve the Google permission prompt (**Drive + Calendar**, to move recordings and read
     the matching event). On the "unverified app" screen: Advanced → Go to project → Allow.
5. Check the **Execution log** shows `Trigger created...` then `Done.`

That's it, new recordings move automatically every 15 minutes.

## What to expect

- **Only recordings made after you run `setup` are moved.** Your existing recording history
  is left alone (the log shows `skippedOld=N` for those). This prevents dumping your whole
  back-catalog into the shared folder.
- A recording leaves your personal "Meet Recordings" folder once moved (it now lives in the
  Shared Drive). Want to keep a personal copy? Tell the product team and we can switch the
  script to copy instead of move.
- The script only touches `video/mp4` files in your Meet Recordings folder, never your docs
  or anything else.
- It reads the **matching calendar event** (your own calendar, read-only) and tags the
  recording with the organizer and guests, so Notion gets the meeting's **Host / Invited /
  Attendees**. Ad-hoc Meets with no calendar event still work; they just won't have a guest
  list (the app falls back to names mentioned in the meeting).
- After processing, the app keeps a small **audio** copy in the Shared Drive and (by
  default) trashes the **video after 30 days**. Adjustable in the app's Settings.

## If recordings stop arriving

- In the Apps Script project, open **Triggers** (clock icon); there should be one
  `moveNewRecordings` time trigger. Re-run `setup` to recreate it.
- Confirm you still have Contributor access to the Shared Drive.
- Check the app's dashboard poll history for per-folder errors.

## Privacy note

Recorded meetings are transcribed and summarized into a shared Notion database others can
read. Make sure participants know a meeting is being recorded and captured. If a meeting
shouldn't be transcribed, don't record it (or keep that recording out of the Shared Drive).
