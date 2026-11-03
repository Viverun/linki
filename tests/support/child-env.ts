/**
 * Environment for a Node process spawned BY a test.
 *
 * Such a child is not a test run: its configuration was constructed by the test
 * that spawned it, not inherited from an operator's shell. `scripts/test-setup.mjs`
 * decides whether to sanitise by looking for the runner's own markers, and a
 * child spawned with `{ ...process.env }` still carries `NODE_TEST_CONTEXT` from
 * the test process — so the bootstrap would treat the CALLER's deliberate
 * `LINKI_DB_PATH` as inherited configuration and redirect it. The child would
 * then open a different database than the fixture the test had just seeded, and
 * the failure reads as a migration bug.
 *
 * Dropping the markers is an accurate description of the child rather than an
 * escape hatch: it is the same state as `node scripts/foo.ts`, which the
 * bootstrap deliberately leaves alone so the live retest and restore-drill tools
 * keep the operator's real environment. `tests/test-env-isolation.test.ts` pins
 * both halves of that rule.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.LINKI_HERMETIC_TEST_ENV;
  delete env.LINKI_TEST_ENV_SCOPE;
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}
