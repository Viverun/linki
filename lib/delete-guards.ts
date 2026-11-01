import { getDb } from "@/lib/db";

/**
 * Deletion guards for resources an executing run still depends on.
 *
 * The rule is the same one already enforced for workflows and runs: refuse
 * rather than delete the row a live step is using. Deleting a run's
 * `run_profiles` out from under it makes the runner's next `log()` insert
 * violate `logs.target_id → targets(id)` (or `logs.run_id → runs(id)`) *after*
 * the external action already happened, and the contact is gone while the
 * LinkedIn message is not.
 *
 * "Active" means `running` or `paused`: a paused run is stopped for a moment,
 * not abandoned, and resuming it must not discover that its targets vanished.
 * Terminal runs (`completed`, `failed`) cannot act again, so their resources
 * are deletable.
 */
type Db = ReturnType<typeof getDb>;

/** SQL fragment: run statuses that can still perform external work. */
const ACTIVE_RUN_STATUSES = "('running', 'paused')";

/** Active runs that still include at least one of these targets. */
export function activeRunCountForTargets(db: Db, targetIds: string[]): number {
  if (targetIds.length === 0) return 0;
  const placeholders = targetIds.map(() => "?").join(",");
  return (db.prepare(
    `SELECT COUNT(DISTINCT r.id) AS c
     FROM runs r
     JOIN run_profiles rp ON rp.run_id = r.id
     WHERE r.status IN ${ACTIVE_RUN_STATUSES}
       AND rp.target_id IN (${placeholders})`
  ).get(...targetIds) as { c: number }).c;
}

/** Active runs created from this list. */
export function activeRunCountForList(db: Db, listId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM runs
     WHERE status IN ${ACTIVE_RUN_STATUSES} AND list_id = ?`
  ).get(listId) as { c: number }).c;
}

/**
 * Active runs that send from this email account. Matched on both
 * `runs.email_account_id` and `run_profiles.email_account_id`: the profile is
 * the actual sender, and accounts may be rotated without updating the run row.
 */
export function activeRunCountForEmailAccount(db: Db, emailAccountId: string): number {
  return (db.prepare(
    `SELECT COUNT(DISTINCT r.id) AS c
     FROM runs r
     WHERE r.status IN ${ACTIVE_RUN_STATUSES}
       AND (
         r.email_account_id = ?
         OR EXISTS (
           SELECT 1 FROM run_profiles rp
           WHERE rp.run_id = r.id AND rp.email_account_id = ?
         )
       )`
  ).get(emailAccountId, emailAccountId) as { c: number }).c;
}
