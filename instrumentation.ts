// Next.js runs this once when the server process boots.
export async function register() {
  // Only run in the Node.js server runtime (not edge / browser).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/cron");
    startScheduler();
  }
}
