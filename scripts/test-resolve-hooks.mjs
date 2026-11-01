// Resolve hooks for `node --test`.
//
// The app's source is bundler-resolved (Next), so it imports siblings
// extensionless (`./pending-invitations`) and uses the `@/*` path alias. Node's
// ESM resolver does neither. These hooks bridge the gap so test files can load
// the real modules unchanged, with no build step and no extra dependency.
import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;

  if (spec.startsWith("@/")) {
    spec = pathToFileURL(resolvePath(projectRoot, spec.slice(2))).href;
  }

  try {
    return await nextResolve(spec, context);
  } catch (err) {
    // ERR_UNSUPPORTED_DIR_IMPORT matters here: `pages/api/targets/[id].ts` sits
    // beside a `pages/api/targets/[id]/` directory, so the natural specifier
    // resolves to the directory and Node refuses it. Bundlers (and Next) pick
    // the file first, and candidate list order below reproduces that. A real
    // directory import (`./support` → `./support/index.ts`) is fixed by the
    // same retry.
    const retryable = err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    if (!retryable || /\.[cm]?[jt]sx?$/.test(spec)) throw err;
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      try {
        return await nextResolve(spec + ext, context);
      } catch {
        // try the next candidate extension
      }
    }
    throw err;
  }
}
