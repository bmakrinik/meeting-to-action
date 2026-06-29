import cron, { ScheduledTask } from "node-cron";
import { getSettings } from "./settings";
import { runPoll } from "./poll";

// Guard against double-scheduling across hot reloads in dev.
const g = globalThis as unknown as {
  __mta_task?: ScheduledTask;
  __mta_interval?: number;
  __mta_running?: boolean;
};

function expr(minutes: number): string {
  const m = Math.max(1, Math.min(59, Math.floor(minutes)));
  return `*/${m} * * * *`;
}

export function startScheduler(): void {
  const settings = getSettings();
  if (!settings.cronEnabled) {
    console.log("[cron] scheduler disabled in settings; not starting.");
    return;
  }
  if (g.__mta_task && g.__mta_interval === settings.pollIntervalMinutes) {
    return; // already running at the right cadence
  }
  if (g.__mta_task) {
    g.__mta_task.stop();
    g.__mta_task = undefined;
  }

  const schedule = expr(settings.pollIntervalMinutes);
  console.log(`[cron] starting poll every ${settings.pollIntervalMinutes} min (${schedule})`);

  g.__mta_task = cron.schedule(schedule, async () => {
    if (g.__mta_running) {
      console.log("[cron] previous run still in progress; skipping tick.");
      return;
    }
    g.__mta_running = true;
    try {
      const { poll } = await runPoll("cron");
      if (poll.found || poll.error) {
        console.log(
          `[cron] poll: found=${poll.found} ok=${poll.succeeded} failed=${poll.failed}` +
            (poll.error ? ` error=${poll.error}` : "")
        );
      }
    } catch (e) {
      console.error("[cron] poll failed:", e);
    } finally {
      g.__mta_running = false;
    }
  });
  g.__mta_interval = settings.pollIntervalMinutes;
}

export function stopScheduler(): void {
  if (g.__mta_task) {
    g.__mta_task.stop();
    g.__mta_task = undefined;
    g.__mta_interval = undefined;
    console.log("[cron] scheduler stopped.");
  }
}

// Call after settings change so cadence/enabled state take effect without a restart.
export function restartScheduler(): void {
  stopScheduler();
  startScheduler();
}
