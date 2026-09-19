import type { BrowserContext, Page } from "playwright";

/**
 * Per-account browser ownership (C2-B1 / PR-09).
 *
 * B6 (CPU-spike incident) serialised page OPENS through one queue with a 120 s
 * safety valve. That valve is exactly what let an import scrape and a runner
 * step drive the same Chromium at once: after 120 s the queue moved on while the
 * import still held its page. Ownership replaces the valve: one holder per
 * account; when the max hold expires the holder is ABORTED — its signal fires and
 * every page of the account's context is closed, so its pending Playwright calls
 * reject — and the next holder is admitted only after the previous one settled.
 * Timeout ends owned work; it never overlaps a replacement.
 *
 * The slot is claimed SYNCHRONOUSLY (no `await` between the free-check and
 * `s.holder = ...`), and admission of a queued waiter also sets `s.holder`
 * synchronously inside `admitNext` — before the waiter's promise resolves.
 * From the instant a slot frees it is either null-with-empty-queue, or
 * already reserved for the next admitted waiter: a fast-path caller can
 * never race an admission and see the slot as free when it is not.
 */
export const PAGE_TEARDOWN_GAP_MS = 3000;

export interface BrowserOwner {
  readonly accountId: string;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly context: BrowserContext;
  newPage(): Promise<Page>;
}
export interface AcquireOptions { maxHoldMs: number; waitMs?: number }
export class BrowserBusyError extends Error {
  readonly heldBy: string;
  constructor(accountId: string, heldBy: string) {
    super(`browser for account ${accountId} is owned by ${heldBy}`);
    this.heldBy = heldBy;
  }
}

interface Holder { label: string; since: string; abort: AbortController }
interface QueueEntry { holder: Holder; resolve: () => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
interface Slot { holder: Holder | null; queue: QueueEntry[] }
const slots = new Map<string, Slot>();
const slot = (id: string) => slots.get(id) ?? (slots.set(id, { holder: null, queue: [] }), slots.get(id)!);

let contextProvider: (accountId: string) => Promise<BrowserContext> = async () => { throw new Error("browser context provider not wired (session.ts sets it)"); };
/** session.ts wires the real provider; tests wire fakes. */
export function setBrowserContextProvider(p: (accountId: string) => Promise<BrowserContext>): void { contextProvider = p; }

export function browserOwnerState(accountId: string): { heldBy: string; since: string } | null {
  const h = slots.get(accountId)?.holder;
  return h ? { heldBy: h.label, since: h.since } : null;
}

// Ref'd on purpose: an admitted waiter is live work; an unref'd gap timer let Node exit mid-await (gate failure under Node 22).
const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

/** Sets `s.holder` to the admitted entry's holder BEFORE resolving it — the reservation is visible synchronously. */
function admitNext(accountId: string): void {
  const s = slot(accountId);
  const next = s.queue.shift();
  if (!next) return;
  if (next.timer) clearTimeout(next.timer);
  s.holder = next.holder;
  next.resolve();
}

export async function acquireBrowserOwner(accountId: string, label: string, opts: AcquireOptions): Promise<{ owner: BrowserOwner; release: () => Promise<void> }> {
  const s = slot(accountId);
  const holder: Holder = { label, since: new Date().toISOString(), abort: new AbortController() };
  let admittedImmediately: boolean;
  if (!s.holder && s.queue.length === 0) {
    s.holder = holder;                    // claimed synchronously — no await before this line
    admittedImmediately = true;
  } else {
    if (opts.waitMs === 0) throw new BrowserBusyError(accountId, s.holder?.label ?? s.queue[0]?.holder.label ?? "queued");
    await new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { holder, resolve, reject };
      if (opts.waitMs !== undefined) {
        const t = setTimeout(() => {
          const i = s.queue.indexOf(entry);
          if (i >= 0) { s.queue.splice(i, 1); reject(new BrowserBusyError(accountId, s.holder?.label ?? "queued")); }
        }, opts.waitMs);
        (t as { unref?: () => void }).unref?.();
        entry.timer = t;
      }
      s.queue.push(entry);
    });
    admittedImmediately = false;
  }

  const abort = holder.abort;
  if (!admittedImmediately) {
    // the admitted waiter pays the teardown gap — a fast-path acquire on an idle slot pays none.
    await sleep(PAGE_TEARDOWN_GAP_MS);
  }

  let context: BrowserContext;
  try {
    context = await contextProvider(accountId);
  } catch (err) {
    s.holder = null;
    admitNext(accountId);
    throw err;
  }
  const closeAll = async () => { for (const p of context.pages()) { try { await p.close(); } catch { /* already gone */ } } };
  const timer = setTimeout(() => { abort.abort(new Error(`max hold ${opts.maxHoldMs} ms exceeded by ${label}`)); void closeAll(); }, opts.maxHoldMs);
  (timer as { unref?: () => void }).unref?.();
  const newPage = async (): Promise<Page> => {
    if (abort.signal.aborted) {
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason ?? "aborted"));
    }
    return context.newPage();
  };
  const owner: BrowserOwner = { accountId, label, signal: abort.signal, context, newPage };
  let released = false;
  const release = async () => {
    if (released) return; released = true;
    clearTimeout(timer);
    if (abort.signal.aborted) await closeAll();      // the holder was cut off — make sure nothing of it survives
    s.holder = null;
    admitNext(accountId);
  };
  return { owner, release };
}

export async function withBrowserOwner<T>(accountId: string, label: string, opts: AcquireOptions, fn: (owner: BrowserOwner) => Promise<T>): Promise<T> {
  const { owner, release } = await acquireBrowserOwner(accountId, label, opts);
  try { return await fn(owner); } finally { await release(); }
}

export async function tryWithBrowserOwner<T>(accountId: string, label: string, opts: { maxHoldMs: number }, fn: (owner: BrowserOwner) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }> {
  try {
    const value = await withBrowserOwner(accountId, label, { ...opts, waitMs: 0 }, fn);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof BrowserBusyError) return { ok: false, heldBy: err.heldBy };
    throw err;
  }
}
