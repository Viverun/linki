import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeOnly } from "./support/source-text";

/**
 * PR-08 (C3): truthful delete feedback.
 *
 * The server now refuses some deletes with 409 (live run, run history). Every
 * caller of a refusable DELETE must therefore branch on `res.ok` BEFORE it
 * reports success or mutates local state. The bug this pins down already
 * shipped once — `pages/settings.tsx` claimed "Deleted" on a refused account
 * delete and dropped the row locally, so the contact/account vanished from the
 * screen and reappeared on refresh.
 *
 * Asserted structurally rather than by string equality: the requirement is the
 * ORDER of the guard, the failure branch, and the mutation — not the wording.
 */

const root = join(import.meta.dirname, "..");

/**
 * The handler whose body contains `needle`, from its `function` keyword to the
 * start of the next top-level-ish declaration. Comments are stripped so the
 * prose above a guard cannot satisfy or trip an assertion; strings are kept
 * because the fetch URL identifies the handler.
 */
function handlerContaining(file: string, call: string): string {
  const src = codeOnly(readFileSync(join(root, file), "utf8"), { strings: false });

  // The prefix also matches non-delete calls (`/api/accounts/${id}/login`), so
  // take the first occurrence whose statement is a DELETE.
  let at = -1;
  for (let i = src.indexOf(call); i >= 0; i = src.indexOf(call, i + 1)) {
    const statement = src.slice(i, src.indexOf(";", i));
    if (/method:\s*"DELETE"/.test(statement)) { at = i; break; }
  }
  assert.ok(at >= 0, `${file}: no DELETE call to ${call}`);

  const before = src.slice(0, at);
  const decls = [...before.matchAll(/(?:async )?function\s+\w+\s*\(/g)];
  const decl = decls.at(-1);
  assert.ok(decl?.index !== undefined, `${file}: ${call} is not inside a function`);

  const body = src.slice(decl.index);
  const next = body.slice(1).search(/\n {2}(?:async )?function\s/);
  return next === -1 ? body : body.slice(0, next + 1);
}

interface Case {
  file: string;
  call: string;
  mutation: string;
  label: string;
}

const CASES: Case[] = [
  { file: "pages/lists/index.tsx", call: "`/api/lists/", mutation: "setLists(", label: "list delete" },
  { file: "pages/companies/index.tsx", call: "`/api/companies/", mutation: "setCompanies(", label: "company delete" },
  { file: "pages/settings.tsx", call: "`/api/email-accounts/", mutation: "setAccounts(", label: "email-account delete" },
  { file: "pages/settings.tsx", call: "`/api/accounts/", mutation: "setAccounts(", label: "LinkedIn-account delete" },
  { file: "pages/workflows/index.tsx", call: "`/api/workflows/", mutation: "setWorkflows(", label: "campaign delete" },
];

for (const c of CASES) {
  test(`${c.label}: refuses to report success when the server refuses`, () => {
    const body = handlerContaining(c.file, c.call);

    const guardAt = body.indexOf("if (!res.ok)");
    const mutationAt = body.indexOf(c.mutation);

    assert.ok(guardAt >= 0, `${c.file}: ${c.label} does not check res.ok`);
    assert.ok(mutationAt >= 0, `${c.file}: ${c.label} does not update local state`);
    assert.ok(
      guardAt < mutationAt,
      `${c.file}: ${c.label} mutates local state before checking res.ok`
    );

    // Between the failed check and the mutation there must be a visible error
    // and an early return — otherwise an error toast plus a mutation would
    // still leave the UI claiming a row is gone while the DB still has it.
    const failureBranch = body.slice(guardAt, mutationAt);
    assert.match(failureBranch, /toast\.error\(/, `${c.file}: ${c.label} is silent on refusal`);
    assert.match(failureBranch, /\breturn\b/, `${c.file}: ${c.label} continues after a refusal`);
  });
}
