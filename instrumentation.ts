export async function register() {
  // Only run on the Node.js server runtime, not in the browser/edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureGlobalRunnerStarted, startRunnerWatchdog } = await import("@/lib/linkedin/runner");
      ensureGlobalRunnerStarted();
      // Independent timer, so it survives the loop's death (NF-6).
      startRunnerWatchdog();
    } catch (err) {
      console.error("[instrumentation] Failed to start runner:", err);
    }
  }
}
