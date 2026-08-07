/**
 * The Playwright surface this subsystem uses, and how it is loaded.
 *
 * Playwright is NOT a hard dependency, for the reason `lsp/servers.ts` gives
 * about language servers: the package plus one browser is hundreds of megabytes,
 * and most sessions never open a page. So it is behind an indirected `import`
 * (the `llamacpp.ts` trick — a specifier held in a variable, so neither tsc nor
 * tsup tries to resolve a package that may not be installed) and its absence is
 * REPORTED with the command that fixes it.
 *
 * Two absences, two messages, because they are two different mornings. The
 * package can be missing (`pnpm add playwright`), or the package can be present
 * and its browser binary not downloaded (`npx playwright install chromium`) —
 * which is the far more common one, since installing the npm package does not
 * fetch a browser. Collapsing them into "browser unavailable" sends the reader
 * to reinstall a package they already have.
 *
 * The interfaces below are OUR view of Playwright, not Playwright's own types —
 * the same narrowing `processRegistry.ts` does with `ProcessHandle` and
 * `treeSitter.ts` with `TsNode`. It buys two things: this package type-checks
 * with the vendor absent, and a stub can implement the whole surface, which is
 * the only way any of this is testable on a machine with no browser binary.
 */

/** One intercepted request, as the egress guard sees it. */
export interface PwRequest {
  url(): string;
}

/** Playwright's route handle: let it through, or refuse it. */
export interface PwRoute {
  request(): PwRequest;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface PwLocator {
  click(options?: { button?: string; clickCount?: number; timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  selectOption(values: string[], options?: { timeout?: number }): Promise<string[]>;
  setInputFiles(files: string[], options?: { timeout?: number }): Promise<void>;
  dragTo(target: PwLocator, options?: { timeout?: number }): Promise<void>;
  /**
   * Playwright resolves to the PNG BYTES, and writes a file too when `path` is
   * given. Typed as Buffer because the bytes are what we return to the model —
   * `unknown` here would push a cast to every call site.
   */
  screenshot(options?: { path?: string; timeout?: number }): Promise<Buffer>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
}

export interface PwPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  getByText(text: string, options?: { exact?: boolean }): PwLocator;
  /**
   * `(arg: never) => T` accepts a function of ANY parameter type (parameters
   * are contravariant and `never` is the bottom type), which is what lets the
   * in-page collector keep its real signature while this stays honest about
   * the fact that the function is serialised, not called here.
   */
  evaluate<T>(fn: string | ((arg: never) => T), arg?: unknown): Promise<T>;
  screenshot(options?: { path?: string; fullPage?: boolean; timeout?: number }): Promise<Buffer>;
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  keyboard: { press(key: string, options?: { timeout?: number }): Promise<void> };
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface PwBrowserType {
  launch(options?: { headless?: boolean; timeout?: number }): Promise<PwBrowser>;
}

/** The three engines, as `import("playwright")` exposes them. */
export interface PwModule {
  chromium: PwBrowserType;
  firefox: PwBrowserType;
  webkit: PwBrowserType;
}

export type BrowserName = "chromium" | "firefox" | "webkit";

export const BROWSER_NAMES: BrowserName[] = ["chromium", "firefox", "webkit"];

/** Loads the vendor module. Injected, so a stub can stand in for it in tests. */
export type PwLoader = () => Promise<PwModule>;

/** `pnpm add playwright` — the package itself is missing. */
export function packageMissingHint(reason: string): string {
  const how =
    "Add it with `pnpm add playwright`, then download a browser with " +
    "`npx playwright install chromium`.";
  return `Playwright is not installed, so there is no browser to drive. ${how} (${reason})`;
}

/** `npx playwright install <name>` — the package is here, the binary is not. */
export function binaryMissingHint(name: BrowserName, reason: string): string {
  return (
    `Playwright is installed but its ${name} binary is not — installing the npm package does ` +
    `not download a browser. Run \`npx playwright install ${name}\`. (${reason})`
  );
}

/**
 * Whether a launch failure is a missing browser binary rather than anything else.
 *
 * Matched on Playwright's own words. A wrong guess here is cheap in one
 * direction and expensive in the other: mislabelling some other launch failure
 * as "missing binary" sends someone to run an install that will not help, so the
 * patterns are the specific sentences Playwright prints, not a loose "not found".
 */
export function isMissingBrowserBinary(message: string): boolean {
  return (
    /Executable doesn'?t exist/i.test(message) ||
    /playwright install/i.test(message) ||
    /browserType\.launch:.*ENOENT/i.test(message)
  );
}

/**
 * The real loader: a lazy, indirected import.
 *
 * The specifier lives in a variable so that neither `tsc --noEmit` nor tsup
 * tries to resolve `playwright` at build time — this package must type-check and
 * bundle on a machine that has never installed it.
 */
export const importPlaywright: PwLoader = async () => {
  const moduleName = "playwright";
  let mod: unknown;
  try {
    mod = await import(moduleName);
  } catch (err) {
    throw new Error(packageMissingHint(err instanceof Error ? err.message : String(err)));
  }
  const candidate = mod as Partial<PwModule> | undefined;
  if (!candidate?.chromium) {
    // Resolved to something that is not Playwright — a stub, a shadowing local
    // package. Saying so beats a `undefined is not a function` three frames on.
    throw new Error(packageMissingHint("the module resolved but exports no browser types"));
  }
  return candidate as PwModule;
};
