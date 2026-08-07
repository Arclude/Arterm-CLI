/**
 * The browser, kept alive — and everything that keeps it from getting loose.
 *
 * A browser is a long-lived child, the same shape of thing as a language server
 * (`lsp/client.ts`) or a backgrounded process (`core/processRegistry.ts`).
 * Launching one costs a second or two and a few hundred megabytes of RSS, so a
 * tool that launched one per call would be unusable; and a browser still running
 * after the session has ended is precisely the leak the process registry exists
 * to prevent. Hence: cached per engine, capped in tabs, and disposed from one
 * `disposeBrowsers()` that session teardown calls.
 *
 * THE EGRESS BOUNDARY LIVES HERE, and it has to, because nothing else covers it.
 * `bash` is confined by `sandbox.ts`; a browser is a separate process tree that
 * we launch and that fetches whatever the page asks for. `web_fetch` can
 * re-validate every redirect hop itself because it drives the redirect loop — we
 * do not, so a `302` to `169.254.169.254` would never be seen. So there are two
 * layers, with two different jobs:
 *
 *   1. `assertSafeUrl` before `goto`, which exists for the MESSAGE — a refusal
 *      the model can read and act on, rather than `net::ERR_FAILED`.
 *   2. A context-level route guard, which is the BOUNDARY — every request the
 *      context makes, including redirects, subresources, and `fetch()` from
 *      inside `browser_evaluate`, is checked and aborted if it resolves
 *      somewhere private.
 *
 * The route guard fails CLOSED (an error in the check aborts the request),
 * mirroring `sandbox.ts` rather than `telemetry.ts`: this is a control, and a
 * control that degrades to "allow" under load is not one.
 */

import { assertSafeUrl } from "../webFetch.js";
import {
  type CollectOptions,
  type RawNode,
  type RawSnapshot,
  collectSnapshot,
} from "./collector.js";
import {
  type BrowserName,
  type PwBrowser,
  type PwContext,
  type PwLoader,
  type PwLocator,
  type PwPage,
  type PwRoute,
  binaryMissingHint,
  importPlaywright,
  isMissingBrowserBinary,
} from "./vendor.js";

/**
 * How long a page gets, per kind of wait.
 *
 * Environment-overridable for the reason `lsp/client.ts` gives: the right value
 * is a property of the machine and the site, not of this code, and a fixed
 * ceiling turns a slow-but-working setup into a tool that always times out.
 */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
export const actionTimeout = (): number => envMs("ARTERM_BROWSER_TIMEOUT_MS", 15_000);
export const navTimeout = (): number => envMs("ARTERM_BROWSER_NAV_MS", 30_000);
export const launchTimeout = (): number => envMs("ARTERM_BROWSER_LAUNCH_MS", 60_000);

/** The attribute refs are stamped into, inside the page. */
export const REF_ATTR = "data-arterm-ref";

/** Tabs one session may hold open at once, before it must close one. */
const DEFAULT_MAX_PAGES = 8;

/** One open tab, and what the last snapshot said about it. */
export interface PageEntry {
  id: string;
  page: PwPage;
  /** ref → the node it named, for resolution and for readable errors. */
  refs: Map<string, RawNode>;
  /** Refs never restart; see `nextRef`. */
  refCounter: number;
  snapshotAt?: number;
  openedAt: number;
}

export interface BrowserPoolOptions {
  /** How Playwright is obtained. Injected so a stub can stand in for it. */
  load?: PwLoader;
  /** Egress check for an explicit navigation and for every routed request. */
  checkUrl?: (url: string) => Promise<unknown>;
  maxPages?: number;
}

export class BrowserPool {
  private readonly load: PwLoader;
  private readonly checkUrl: (url: string) => Promise<unknown>;
  private readonly maxPages: number;
  private browsers = new Map<string, Promise<{ browser: PwBrowser; context: PwContext }>>();
  private pages = new Map<string, PageEntry>();
  private activeId: string | undefined;
  private pageSeq = 0;
  /** Host verdicts, memoized: every image on a page would otherwise re-resolve DNS. */
  private hostVerdicts = new Map<string, Promise<boolean>>();
  private launched: { name: BrowserName; headless: boolean } | undefined;

  constructor(opts: BrowserPoolOptions = {}) {
    this.load = opts.load ?? importPlaywright;
    this.checkUrl = opts.checkUrl ?? assertSafeUrl;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /** Whether anything has been launched yet — `browser_status` reports it. */
  get engine(): { name: BrowserName; headless: boolean } | undefined {
    return this.launched;
  }

  /**
   * Is the vendor package reachable at all?
   *
   * Loads the module and stops there — deliberately NOT a launch. `browser_status`
   * is the tool someone reaches for when something already failed, and paying a
   * browser launch (a second, and a few hundred megabytes) to answer "is it
   * installed" would make the diagnostic more expensive than the thing it
   * diagnoses. It therefore cannot see a missing BINARY, only a missing package;
   * the binary's absence shows up on the first `browser_open`, with its own hint.
   */
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.load();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Launch (or reuse) a browser and its one context.
   *
   * One context per browser, not one per tab: tabs are expected to share cookies
   * and storage, which is what makes "log in, then open the settings page" work.
   * A rejected launch is NOT cached — the usual cause is a browser that has not
   * been downloaded yet, and caching the rejection would mean the install that
   * fixes it does not take effect until the session restarts.
   */
  private async acquire(
    name: BrowserName,
    headless: boolean,
  ): Promise<{ browser: PwBrowser; context: PwContext }> {
    const key = `${name}:${headless}`;
    let pending = this.browsers.get(key);
    if (!pending) {
      pending = this.start(name, headless);
      this.browsers.set(key, pending);
    }
    try {
      const live = await pending;
      if (!live.browser.isConnected()) {
        // The browser died under us (crash, or an external kill). Drop it and
        // start again rather than handing back a handle whose every call throws.
        this.browsers.delete(key);
        for (const [id, entry] of [...this.pages]) {
          if (entry.page.isClosed()) this.pages.delete(id);
        }
        return this.acquire(name, headless);
      }
      return live;
    } catch (err) {
      this.browsers.delete(key);
      throw err;
    }
  }

  private async start(
    name: BrowserName,
    headless: boolean,
  ): Promise<{ browser: PwBrowser; context: PwContext }> {
    const playwright = await this.load();
    const type = playwright[name];
    if (!type) throw new Error(`Playwright has no browser named "${name}".`);
    let browser: PwBrowser;
    try {
      browser = await type.launch({ headless, timeout: launchTimeout() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The common failure by a wide margin: the npm package is installed and
      // the binary was never downloaded. Playwright says so itself, but says it
      // inside a wall of stack, so the actionable line is re-stated first.
      if (isMissingBrowserBinary(message)) throw new Error(binaryMissingHint(name, message));
      throw new Error(`Could not launch ${name}: ${message}`);
    }
    const context = await browser.newContext();
    await this.guard(context);
    this.launched = { name, headless };
    return { browser, context };
  }

  /**
   * Refuse every request that resolves somewhere private.
   *
   * This is the boundary the tools' own URL checks cannot be: it sees redirects,
   * subresources and in-page `fetch()`, none of which pass through a tool call.
   * Non-http(s) schemes are let through — `data:`, `blob:` and `about:` never
   * leave the browser, and aborting them breaks ordinary pages for nothing.
   */
  private async guard(context: PwContext): Promise<void> {
    await context.route("**/*", async (route: PwRoute) => {
      let url = "";
      try {
        url = route.request().url();
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          await route.continue();
          return;
        }
        if (await this.hostAllowed(parsed)) {
          await route.continue();
          return;
        }
      } catch {
        // Fall through to the abort: a check that could not be completed is not
        // a check that passed.
      }
      await route.abort("blockedbyclient").catch(() => {});
    });
  }

  /** Memoized per origin — a page makes hundreds of requests to the same host. */
  private hostAllowed(parsed: URL): Promise<boolean> {
    const key = parsed.origin;
    let verdict = this.hostVerdicts.get(key);
    if (!verdict) {
      verdict = this.checkUrl(parsed.toString()).then(
        () => true,
        () => false,
      );
      // Bounded: a page that generates unique subdomains must not grow this
      // map without end. Oldest first, which is what insertion order gives.
      if (this.hostVerdicts.size >= 512) {
        const oldest = this.hostVerdicts.keys().next();
        if (!oldest.done) this.hostVerdicts.delete(oldest.value);
      }
      this.hostVerdicts.set(key, verdict);
    }
    return verdict;
  }

  /** Open a new tab. Throws when the cap is reached, naming the way out. */
  async open(opts: { browser?: BrowserName; headless?: boolean } = {}): Promise<PageEntry> {
    this.prune();
    if (this.pages.size >= this.maxPages) {
      const cap = `${this.pages.size} tabs are already open (the cap is ${this.maxPages}).`;
      throw new Error(`${cap} Close one with browser_close before opening another.`);
    }
    const name = opts.browser ?? "chromium";
    const headless = opts.headless ?? true;
    const { context } = await this.acquire(name, headless);
    const page = await context.newPage();
    const id = `tab${++this.pageSeq}`;
    const entry: PageEntry = { id, page, refs: new Map(), refCounter: 1, openedAt: Date.now() };
    this.pages.set(id, entry);
    this.activeId = id;
    return entry;
  }

  /** Drop tabs the site (or a crash) closed behind our back. */
  private prune(): void {
    for (const [id, entry] of [...this.pages]) {
      let closed = false;
      try {
        closed = entry.page.isClosed();
      } catch {
        closed = true;
      }
      if (closed) {
        this.pages.delete(id);
        if (this.activeId === id) this.activeId = undefined;
      }
    }
    if (!this.activeId) {
      const last = [...this.pages.keys()].pop();
      this.activeId = last;
    }
  }

  /**
   * The tab a tool call means: the named one, or the active one.
   *
   * Throws rather than opening one implicitly. An implicit open turns "click the
   * button" on a session with no browser into a blank page and a confusing
   * failure, instead of "open a page first", which is what actually happened.
   */
  require(tab?: string): PageEntry {
    this.prune();
    if (tab) {
      const entry = this.pages.get(tab);
      if (!entry) {
        const open = [...this.pages.keys()];
        throw new Error(
          `No open tab "${tab}".${open.length > 0 ? ` Open: ${open.join(", ")}.` : " None are open — use browser_open."}`,
        );
      }
      this.activeId = tab;
      return entry;
    }
    if (!this.activeId) {
      throw new Error("No browser tab is open. Open one with browser_open first.");
    }
    const entry = this.pages.get(this.activeId);
    if (!entry) throw new Error("No browser tab is open. Open one with browser_open first.");
    return entry;
  }

  list(): PageEntry[] {
    this.prune();
    return [...this.pages.values()];
  }

  get active(): string | undefined {
    return this.activeId;
  }

  /**
   * Navigate, with the pre-check that produces a readable refusal.
   *
   * The refs of the old page are dropped here and not on the next snapshot: a
   * ref names an element in a document that no longer exists, and resolving it
   * against the new one is how "click e5" ends up clicking something nobody
   * asked for.
   */
  async navigate(entry: PageEntry, url: string, waitUntil?: string): Promise<void> {
    await this.checkUrl(url);
    entry.refs.clear();
    await entry.page.goto(url, {
      timeout: navTimeout(),
      ...(waitUntil ? { waitUntil } : {}),
    });
  }

  /** Collect a fresh snapshot and re-key this tab's refs to it. */
  async snapshot(
    entry: PageEntry,
    opts: { mode: "interactive" | "full"; limit: number; selector?: string },
  ): Promise<RawSnapshot> {
    const options: CollectOptions = {
      mode: opts.mode,
      limit: opts.limit,
      refAttr: REF_ATTR,
      startIndex: entry.refCounter,
      ...(opts.selector ? { selector: opts.selector } : {}),
    };
    const snap = await entry.page.evaluate(collectSnapshot, options);
    entry.refs.clear();
    for (const node of snap.nodes) entry.refs.set(node.ref, node);
    entry.refCounter += Math.max(snap.nodes.length, 1);
    entry.snapshotAt = Date.now();
    return snap;
  }

  /**
   * A ref, resolved to a locator — or an immediate, specific failure.
   *
   * Checked against our own map first, which is the whole point: handing an
   * unknown ref to Playwright buys a fifteen-second wait and then "locator
   * resolved to 0 elements", when the real answer ("that ref is from a snapshot
   * two navigations ago") was knowable at once.
   */
  locate(entry: PageEntry, ref: string): PwLocator {
    const node = entry.refs.get(ref);
    if (!node) {
      const known = [...entry.refs.keys()];
      const detail =
        known.length === 0
          ? "This tab has no current snapshot — take a browser_snapshot first."
          : `Current refs: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}.`;
      throw new Error(`Unknown element ref "${ref}" on ${entry.id}. ${detail}`);
    }
    return entry.page.locator(`[${REF_ATTR}="${ref}"]`);
  }

  /** What the last snapshot said an element was, for previews and messages. */
  describe(entry: PageEntry, ref: string): string {
    const node = entry.refs.get(ref);
    if (!node) return ref;
    return `${node.role}${node.name ? ` "${node.name}"` : ""}`;
  }

  async close(tab: string): Promise<boolean> {
    const entry = this.pages.get(tab);
    if (!entry) return false;
    this.pages.delete(tab);
    if (this.activeId === tab) this.activeId = undefined;
    try {
      await entry.page.close();
    } catch {
      // Already gone; the ledger is what matters.
    }
    this.prune();
    return true;
  }

  /**
   * Close everything this pool started. Idempotent, and never throws: it runs on
   * the teardown path, where a failure would mask whatever the session was
   * actually reporting.
   */
  async disposeAll(): Promise<number> {
    const pages = [...this.pages.values()];
    const browsers = [...this.browsers.values()];
    this.pages.clear();
    this.browsers.clear();
    this.hostVerdicts.clear();
    this.activeId = undefined;
    this.launched = undefined;
    await Promise.all(pages.map((p) => Promise.resolve(p.page.close()).catch(() => {})));
    await Promise.all(
      browsers.map((pending) =>
        pending
          .then(async ({ browser, context }) => {
            await Promise.resolve(context.close()).catch(() => {});
            await Promise.resolve(browser.close()).catch(() => {});
          })
          .catch(() => {}),
      ),
    );
    return pages.length;
  }
}
