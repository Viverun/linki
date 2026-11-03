/**
 * "Is this process a test run?" — the one decision `scripts/test-setup.mjs`
 * makes before it decides whether to sanitise the environment.
 *
 * Extracted as a pure function for two reasons:
 *
 *   1. It was not testable where it mattered. The gate runs Node 22.23, which has
 *      no `--test-isolation=none`; asserting that branch by spawning
 *      `node --test --test-isolation=none` passed here on Node 24 and failed
 *      there with "bad option", which is a test that measures the Node version
 *      rather than the decision.
 *   2. The consequence of getting it wrong is asymmetric. Sanitising when it
 *      should not have broken the live retest and restore-drill tools; not
 *      sanitising when it should have quietly reintroduced the leak PR-16 is
 *      about, and only an environment with sentinels would ever notice.
 *
 * Signals, in order: the runner's own child marker (every `node --test` child),
 * `--test` in execArgv (the same process runs the tests when isolation is
 * disabled, so there is no child marker), and an explicit marker for harnesses
 * that invoke test files directly without the runner.
 */
export function testRunScope(env, execArgv) {
  if (env.NODE_TEST_CONTEXT !== undefined) return "runner-child";
  if (execArgv.some((arg) => arg === "--test" || arg.startsWith("--test="))) return "execargv";
  if (env.LINKI_HERMETIC_TEST_ENV === "1") return "marker";
  return null;
}
