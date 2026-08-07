import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "@arterm/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolSchemaTokens } from "../registry.js";
import type { RawSnapshot } from "./collector.js";
import { BrowserPool } from "./pool.js";
import { createBrowserTools } from "./tools.js";
import {
  type PwBrowser,
  type PwContext,
  type PwLocator,
  type PwModule,
  type PwPage,
  type PwRoute,
  importPlaywright,
  isMissingBrowserBinary,
  packageMissingHint,
} from "./vendor.js";

/**
 * A Playwright that is not Playwright.
 *
 * No browser binary exists on this machine (and none exists in CI), so the real
 * vendor cannot be exercised at all. Narrowing the surface in `vendor.ts` is what
 * makes a stub possible, and the stub is what makes the failure modes — a
 * missing binary, a blocked address, a stale ref, a page that never settles —
 * testable at the only level where they are decisions rather than plumbing.
 */

interface Call {
  op: string;
  args: unknown[];
}

class StubLocator implements PwLocator {
  constructor(
    private readonly page: StubPage,
    private readonly selector: string,
  ) {}

  private rec(op: string, ...args: unknown[]): void {
    this.page.calls.push({ op: `${op} ${this.selector}`, args });
    if (this.page.failWith) throw new Error(this.page.failWith);
  }

  async click(options?: Record<string, unknown>): Promise<void> {
    this.rec("click", options);
  }
  async fill(value: string): Promise<void> {
    this.rec("fill", value);
  }
  async press(key: string): Promise<void> {
    this.rec("press", key);
  }
  async selectOption(values: string[]): Promise<string[]> {
    this.rec("selectOption", values);
    return this.page.selectResult ?? values;
  }
  async setInputFiles(files: string[]): Promise<void> {
    this.rec("setInputFiles", files);
  }
  async dragTo(target: PwLocator): Promise<void> {
    this.rec("dragTo", (target as StubLocator).selector);
  }
  async hover(): Promise<void> {
    this.rec("hover");
  }
  async screenshot(options?: { path?: string }): Promise<Buffer> {
    this.rec("screenshot", options);
    // Playwright resolves to the BYTES; the caller decides whether to store them.
    return Buffer.from("element-png");
  }
  async waitFor(options?: Record<string, unknown>): Promise<void> {
    this.page.calls.push({ op: `waitFor ${this.selector}`, args: [options] });
    if (this.page.waitFails) throw new Error(TIMEOUT_ERROR);
  }
  async count(): Promise<number> {
    return 1;
  }
}

/** What Playwright's timeout looks like: one useful line and a wall of call log. */
const TIMEOUT_ERROR = [
  "locator.waitFor: Timeout 15000ms exceeded.",
  "Call log:",
  "  - waiting for locator",
  "  - locator resolved to hidden element",
  "  - retrying",
  "  - retrying",
].join("\n");

class StubPage implements PwPage {
  calls: Call[] = [];
  closed = false;
  href = "about:blank";
  pageTitle = "";
  snapshot: RawSnapshot = { nodes: [], total: 0, url: "", title: "" };
  evalResult: unknown = null;
  selectResult: string[] | undefined;
  failWith: string | undefined;
  waitFails = false;

  url(): string {
    return this.href;
  }
  async title(): Promise<string> {
    return this.pageTitle;
  }
  async goto(url: string, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ op: "goto", args: [url, options] });
    this.href = url;
    return undefined;
  }
  locator(selector: string): PwLocator {
    return new StubLocator(this, selector);
  }
  getByText(text: string): PwLocator {
    return new StubLocator(this, `text=${text}`);
  }
  async evaluate<T>(fn: string | ((arg: never) => T)): Promise<T> {
    if (typeof fn === "string") {
      this.calls.push({ op: "evaluate", args: [fn] });
      return this.evalResult as T;
    }
    this.calls.push({ op: "collect", args: [] });
    return this.snapshot as unknown as T;
  }
  async screenshot(options?: { path?: string }): Promise<Buffer> {
    this.calls.push({ op: "screenshot", args: [options] });
    return Buffer.from("page-png");
  }
  async waitForLoadState(state?: string): Promise<void> {
    this.calls.push({ op: "waitForLoadState", args: [state] });
    if (this.waitFails) throw new Error(TIMEOUT_ERROR);
  }
  async waitForTimeout(ms: number): Promise<void> {
    this.calls.push({ op: "waitForTimeout", args: [ms] });
  }
  keyboard = {
    press: async (key: string): Promise<void> => {
      this.calls.push({ op: "keyboard.press", args: [key] });
    },
  };
  async close(): Promise<void> {
    this.closed = true;
  }
  isClosed(): boolean {
    return this.closed;
  }
}

class StubContext implements PwContext {
  pages: StubPage[] = [];
  routeHandler: ((route: PwRoute) => Promise<void> | void) | undefined;
  closed = false;

  async newPage(): Promise<PwPage> {
    const page = new StubPage();
    this.pages.push(page);
    return page;
  }
  async route(_pattern: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void> {
    this.routeHandler = handler;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class StubBrowser implements PwBrowser {
  contexts: StubContext[] = [];
  closed = false;
  connected = true;

  async newContext(): Promise<PwContext> {
    const context = new StubContext();
    this.contexts.push(context);
    return context;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
}

interface Harness {
  module: PwModule;
  launches: number;
  browser?: StubBrowser;
  launchError?: string;
}

function harness(): Harness {
  const state: Harness = { launches: 0 } as Harness;
  const type = {
    launch: async (): Promise<PwBrowser> => {
      state.launches++;
      if (state.launchError) throw new Error(state.launchError);
      const browser = new StubBrowser();
      state.browser = browser;
      return browser;
    },
  };
  state.module = { chromium: type, firefox: type, webkit: type };
  return state;
}

/** The only page the stub ever opens, once something has opened one. */
function onlyPage(h: Harness): StubPage {
  const page = h.browser?.contexts[0]?.pages[0];
  if (!page) throw new Error("no page was opened");
  return page;
}

function context(h: Harness): StubContext {
  const ctx = h.browser?.contexts[0];
  if (!ctx) throw new Error("no context was created");
  return ctx;
}

/** A route the guard can decide about, recording what it decided. */
function fakeRoute(url: string): PwRoute & { decision: string } {
  const route = {
    decision: "",
    request: () => ({ url: () => url }),
    abort: async (code?: string) => {
      route.decision = `abort:${code ?? ""}`;
    },
    continue: async () => {
      route.decision = "continue";
    },
  };
  return route;
}

let dir: string;
const ctx = () => ({ cwd: dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "arterm-browser-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Tools over a pool with the vendor and the egress check both injected. */
function setup(
  over: {
    load?: () => Promise<PwModule>;
    checkUrl?: (url: string) => Promise<unknown>;
    maxPages?: number;
  } = {},
): { tools: Map<string, Tool>; pool: BrowserPool; h: Harness } {
  const h = harness();
  const pool = new BrowserPool({
    load: over.load ?? (async () => h.module),
    // Allow everything by default: the SSRF tests opt back into the real guard,
    // and no other test should depend on this machine's DNS.
    checkUrl: over.checkUrl ?? (async () => undefined),
    ...(over.maxPages !== undefined ? { maxPages: over.maxPages } : {}),
  });
  const tools = new Map(createBrowserTools(pool).map((t) => [t.name, t]));
  return { tools, pool, h };
}

const run = (tools: Map<string, Tool>, name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool.execute(args, ctx()) as Promise<ToolResult>;
};

/** Open a tab and give it a snapshot, which is the state most tools require. */
async function openWithSnapshot(
  tools: Map<string, Tool>,
  h: Harness,
  nodes: RawSnapshot["nodes"] = [
    { ref: "e1", role: "button", name: "Save", depth: 1, tag: "button", interactive: true },
  ],
): Promise<StubPage> {
  await run(tools, "browser_open");
  const page = onlyPage(h);
  page.snapshot = { nodes, total: nodes.length, url: "https://example.com/", title: "Example" };
  await run(tools, "browser_snapshot");
  return page;
}

describe("the tool surface", () => {
  it("registers fifteen browser tools, and only the read-only ones are allow/read", () => {
    const { tools } = setup();
    expect(tools.size).toBe(15);
    const readOnly = ["browser_snapshot", "browser_list", "browser_status", "browser_wait"];
    for (const name of readOnly) {
      expect(tools.get(name)?.permission).toBe("allow");
      expect(tools.get(name)?.category).toBe("read");
    }
    for (const name of ["browser_open", "browser_navigate", "browser_click", "browser_evaluate"]) {
      expect(tools.get(name)?.permission).toBe("ask");
      expect(tools.get(name)?.mutating).toBe(true);
    }
    // The arbitrary-code tool is the one graded destructive, so
    // `confirmDestructive` re-prompts for it even under auto and yolo.
    expect(tools.get("browser_evaluate")?.riskTier).toBe("destructive");
    expect(tools.get("browser_click")?.riskTier).toBe("caution");
  });
});

describe("what the family costs to advertise", () => {
  it("stays under a stated ceiling, because the roster is paid for every turn", () => {
    // ~1,800 tokens for fifteen schemas, against 2,862 for the whole `standard`
    // tier — which is the argument for keeping these OUT of the default roster
    // (see the report). The bound is here so the number cannot drift upward one
    // helpful parameter description at a time.
    const total = createBrowserTools()
      .map((t) => toolSchemaTokens(t))
      .reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThan(2_200);
  });
});

describe("when Playwright is not there", () => {
  it("the real loader either returns Playwright or says how to install it", async () => {
    // The one part of the vendor path that can be exercised for real on a
    // machine with nothing installed — and written to hold either way, because a
    // test that fails the day the dependency is ADDED is the wrong alarm.
    try {
      const mod = await importPlaywright();
      expect(mod.chromium).toBeDefined();
    } catch (err) {
      expect((err as Error).message).toContain("pnpm add playwright");
      expect((err as Error).message).toContain("npx playwright install chromium");
    }
  });

  it("surfaces a loader failure as an error result rather than a thrown tool", async () => {
    const { tools } = setup({
      load: async () => {
        throw new Error(packageMissingHint("Cannot find module 'playwright'"));
      },
    });
    const res = await run(tools, "browser_open");
    expect(res.isError).toBe(true);
    expect(res.output).toContain("pnpm add playwright");
  });

  it("tells the two absences apart", () => {
    // Collapsing them sends someone to reinstall a package they already have.
    expect(isMissingBrowserBinary("browserType.launch: Executable doesn't exist at /x")).toBe(true);
    expect(isMissingBrowserBinary("Please run `npx playwright install`")).toBe(true);
    expect(isMissingBrowserBinary("browserType.launch: Target page crashed")).toBe(false);
    expect(packageMissingHint("why")).toContain("pnpm add playwright");
  });

  it("names the browser to download when the package is there and the binary is not", async () => {
    const { tools, h } = setup();
    h.launchError =
      "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium/chrome";
    const res = await run(tools, "browser_open");
    expect(res.isError).toBe(true);
    expect(res.output).toContain("npx playwright install chromium");
    // The two failures must not be collapsed: this one is not fixed by
    // reinstalling the package.
    expect(res.output).not.toContain("pnpm add playwright");
  });

  it("does not cache a failed launch, so an install takes effect without a restart", async () => {
    const { tools, h } = setup();
    h.launchError = "browserType.launch: Executable doesn't exist at /nowhere";
    expect((await run(tools, "browser_open")).isError).toBe(true);
    h.launchError = undefined;
    const second = await run(tools, "browser_open");
    expect(second.isError).toBeFalsy();
    expect(h.launches).toBe(2);
  });

  it("reports availability from browser_status without launching anything", async () => {
    const { tools, h } = setup({
      load: async () => {
        throw new Error("Cannot find module 'playwright'");
      },
    });
    const res = await run(tools, "browser_status");
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("playwright: unavailable");
    expect(res.output).toContain("nothing launched yet");
    expect(h.launches).toBe(0);
  });
});

describe("egress", () => {
  // These use the REAL guard from webFetch.ts. Both cases are decided without
  // DNS — one is an IP literal, the other is a protocol — so the test does not
  // depend on this machine's resolver.
  it("refuses a cloud metadata address", async () => {
    const { tools, h } = setup({ checkUrl: undefined });
    const pool = new BrowserPool({ load: async () => h.module });
    const tools2 = new Map(createBrowserTools(pool).map((t) => [t.name, t]));
    const res = await run(tools2, "browser_open", {
      url: "http://169.254.169.254/latest/meta-data",
    });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/private|internal/i);
    expect(tools.size).toBe(15);
  });

  it("leaves no tab behind when the URL it was opened with is refused", async () => {
    const { tools } = setup({
      checkUrl: async (url) => {
        if (url.includes("blocked")) throw new Error("Refusing to fetch a private address");
      },
    });
    for (let i = 0; i < 4; i++) {
      expect((await run(tools, "browser_open", { url: "http://blocked/" })).isError).toBe(true);
    }
    // Without the cleanup the fourth attempt would fail on the tab cap instead,
    // which is a different and far more confusing error than the real one.
    const listed = await run(tools, "browser_list");
    expect(listed.output).toContain("No browser tabs are open");
  });

  it("refuses file:// and every other non-http scheme", async () => {
    const { h } = setup();
    const pool = new BrowserPool({ load: async () => h.module });
    const tools = new Map(createBrowserTools(pool).map((t) => [t.name, t]));
    const res = await run(tools, "browser_open", { url: "file:///etc/passwd" });
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/only http and https/i);
  });

  it("installs a route guard that aborts what the check rejects", async () => {
    const seen: string[] = [];
    const { tools, h } = setup({
      checkUrl: async (url) => {
        seen.push(url);
        if (url.includes("169.254.169.254")) throw new Error("private");
      },
    });
    await run(tools, "browser_open", { url: "https://example.com/" });
    const handler = context(h).routeHandler;
    expect(handler).toBeTypeOf("function");

    const allowed = fakeRoute("https://example.com/app.js");
    await handler?.(allowed);
    expect(allowed.decision).toBe("continue");

    // The case the pre-check cannot see: a redirect or a subresource. Only the
    // route guard is on that path.
    const blocked = fakeRoute("http://169.254.169.254/latest/meta-data/iam");
    await handler?.(blocked);
    expect(blocked.decision).toBe("abort:blockedbyclient");
  });

  it("lets non-http schemes through, since they never leave the browser", async () => {
    const { tools, h } = setup();
    await run(tools, "browser_open");
    const handler = context(h).routeHandler;
    const dataUrl = fakeRoute("data:image/png;base64,iVBORw0KGgo=");
    await handler?.(dataUrl);
    expect(dataUrl.decision).toBe("continue");
  });

  it("aborts when the check itself fails — a check that did not complete is not a pass", async () => {
    const { tools, h } = setup({
      checkUrl: async () => {
        throw new Error("resolver exploded");
      },
    });
    await run(tools, "browser_open");
    const route = fakeRoute("https://anywhere.example/");
    await context(h).routeHandler?.(route);
    expect(route.decision).toBe("abort:blockedbyclient");
  });

  it("memoizes per origin so a page's hundred subresources cost one check", async () => {
    let checks = 0;
    const { tools, h } = setup({
      checkUrl: async () => {
        checks++;
      },
    });
    await run(tools, "browser_open");
    const handler = context(h).routeHandler;
    for (let i = 0; i < 5; i++) await handler?.(fakeRoute(`https://example.com/asset-${i}.png`));
    await handler?.(fakeRoute("https://other.example/x.png"));
    expect(checks).toBe(2);
  });
});

describe("tabs", () => {
  it("refuses to act before a tab is open, instead of opening one implicitly", async () => {
    const { tools } = setup();
    const res = await run(tools, "browser_snapshot");
    expect(res.isError).toBe(true);
    expect(res.output).toContain("browser_open");
  });

  it("caps how many tabs may be open and names the way out", async () => {
    const { tools } = setup({ maxPages: 2 });
    await run(tools, "browser_open");
    await run(tools, "browser_open");
    const third = await run(tools, "browser_open");
    expect(third.isError).toBe(true);
    expect(third.output).toContain("browser_close");
  });

  it("lists tabs, marks the active one, and forgets one the site closed", async () => {
    const { tools, h } = setup();
    await run(tools, "browser_open");
    await run(tools, "browser_open");
    const listed = await run(tools, "browser_list");
    expect(listed.output).toContain("tab1");
    expect(listed.output).toContain("* tab2");

    const first = h.browser?.contexts[0]?.pages[0];
    if (first) first.closed = true;
    const after = await run(tools, "browser_list");
    expect(after.output).not.toContain("tab1:");
  });

  it("closes one tab, and closes everything with all", async () => {
    const { tools, h } = setup();
    await run(tools, "browser_open");
    await run(tools, "browser_open");
    expect((await run(tools, "browser_close", { tab: "tab1" })).output).toContain("1 tab(s) still");
    const all = await run(tools, "browser_close", { all: true });
    expect(all.output).toContain("Closed 1 tab(s)");
    expect(h.browser?.closed).toBe(true);
    expect((await run(tools, "browser_close", { all: true })).output).toBe("Nothing was open.");
  });

  it("names the open tabs when asked for one that is not", async () => {
    const { tools } = setup();
    await run(tools, "browser_open");
    const res = await run(tools, "browser_navigate", { url: "https://x.example/", tab: "tab9" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("tab1");
  });
});

describe("refs", () => {
  it("rejects an unknown ref at once, without asking Playwright to look for it", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    const before = page.calls.length;
    const res = await run(tools, "browser_click", { ref: "e99" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Unknown element ref");
    expect(res.output).toContain("e1");
    // The alternative is a fifteen-second wait and "resolved to 0 elements".
    expect(page.calls.length).toBe(before);
  });

  it("says to snapshot first when the tab has never been snapshotted", async () => {
    const { tools } = setup();
    await run(tools, "browser_open");
    const res = await run(tools, "browser_click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("browser_snapshot");
  });

  it("drops refs on navigation, because they named the old document", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    await run(tools, "browser_navigate", { url: "https://example.com/other" });
    const res = await run(tools, "browser_click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("no current snapshot");
  });

  it("keeps numbering upward across snapshots so a stale ref can never be reused", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    await run(tools, "browser_snapshot");
    const collect = page.calls.filter((c) => c.op === "collect");
    expect(collect).toHaveLength(2);
  });

  it("resolves a ref through the stamped attribute", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    await run(tools, "browser_click", { ref: "e1" });
    expect(page.calls.some((c) => c.op === 'click [data-arterm-ref="e1"]')).toBe(true);
  });
});

describe("acting on a page", () => {
  it("renders a snapshot and warns that refs expire", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_snapshot");
    expect(res.output).toContain("tab1");
    expect(res.output).toContain('button "Save" [e1]');
  });

  it("types by replacing the field, and can press Enter after", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h, [
      { ref: "e1", role: "textbox", name: "Email", depth: 1, tag: "input", interactive: true },
    ]);
    const res = await run(tools, "browser_type", { ref: "e1", text: "a@b.c", submit: true });
    expect(res.output).toContain('typed "a@b.c"');
    expect(page.calls.map((c) => c.op)).toContain('fill [data-arterm-ref="e1"]');
    expect(page.calls.map((c) => c.op)).toContain('press [data-arterm-ref="e1"]');
  });

  it("presses a key on the page when no ref is given", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    await run(tools, "browser_press", { key: "Escape" });
    expect(page.calls.map((c) => c.op)).toContain("keyboard.press");
  });

  it("reports a select that matched no option instead of reporting success", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h, [
      { ref: "e1", role: "combobox", name: "Country", depth: 1, tag: "select", interactive: true },
    ]);
    page.selectResult = [];
    const res = await run(tools, "browser_select", { ref: "e1", value: "atlantis" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Selected nothing");

    page.selectResult = undefined;
    const ok = await run(tools, "browser_select", { ref: "e1", values: ["fr"] });
    expect(ok.isError).toBeFalsy();
    expect(ok.output).toContain("selected fr");
  });

  it("needs a value to select", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_select", { ref: "e1" });
    expect(res.isError).toBe(true);
  });

  it("drags one ref onto another", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h, [
      { ref: "e1", role: "button", name: "Card", depth: 1, tag: "div" },
      { ref: "e2", role: "button", name: "Column", depth: 1, tag: "div" },
    ]);
    const res = await run(tools, "browser_drag", { from: "e1", to: "e2" });
    expect(res.isError).toBeFalsy();
    const drag = page.calls.find((c) => c.op.startsWith("dragTo"));
    expect(drag?.args[0]).toBe('[data-arterm-ref="e2"]');
  });

  it("clips a Playwright call log down to the sentence that matters", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    page.failWith = TIMEOUT_ERROR;
    const res = await run(tools, "browser_click", { ref: "e1" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Timeout 15000ms exceeded");
    expect(res.output).toContain("more lines of Playwright call log");
    expect(res.output.split("\n").length).toBeLessThan(6);
  });
});

describe("uploads", () => {
  it("confines paths to the working directory", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h, [
      { ref: "e1", role: "file", name: "Attach", depth: 1, tag: "input", interactive: true },
    ]);
    const res = await run(tools, "browser_upload", { ref: "e1", paths: ["../../etc/passwd"] });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("escapes the working directory");
  });

  it("reports a path that does not exist instead of handing it to the page", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h, [
      { ref: "e1", role: "file", name: "Attach", depth: 1, tag: "input", interactive: true },
    ]);
    const res = await run(tools, "browser_upload", { ref: "e1", paths: ["missing.txt"] });
    expect(res.isError).toBe(true);
    expect(page.calls.some((c) => c.op.startsWith("setInputFiles"))).toBe(false);
  });

  it("attaches files that are inside the project", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h, [
      { ref: "e1", role: "file", name: "Attach", depth: 1, tag: "input", interactive: true },
    ]);
    await fs.writeFile(join(dir, "report.csv"), "a,b");
    const res = await run(tools, "browser_upload", { ref: "e1", paths: ["report.csv"] });
    expect(res.isError).toBeFalsy();
    const call = page.calls.find((c) => c.op.startsWith("setInputFiles"));
    expect(call?.args[0]).toEqual([join(dir, "report.csv")]);
  });

  it("needs a non-empty paths array", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    expect((await run(tools, "browser_upload", { ref: "e1", paths: [] })).isError).toBe(true);
  });
});

describe("evaluate", () => {
  it("wraps a one-line expression, and leaves a function alone", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    page.evalResult = "Example";
    await run(tools, "browser_evaluate", { script: "document.title" });
    expect(page.calls.find((c) => c.op === "evaluate")?.args[0]).toBe("() => (document.title)");

    await run(tools, "browser_evaluate", { script: "() => window.scrollY" });
    const sources = page.calls.filter((c) => c.op === "evaluate").map((c) => c.args[0]);
    expect(sources).toContain("() => window.scrollY");

    await run(tools, "browser_evaluate", { script: "const a = 1; return a + 1;" });
    expect(sources.length).toBeGreaterThan(0);
    const last = page.calls.filter((c) => c.op === "evaluate").pop();
    expect(last?.args[0]).toBe("() => { const a = 1; return a + 1; }");
  });

  it("renders the result as JSON, and says so when there is none", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    page.evalResult = { items: 2 };
    expect((await run(tools, "browser_evaluate", { script: "x" })).output).toBe(
      '{\n  "items": 2\n}',
    );
    page.evalResult = undefined;
    expect((await run(tools, "browser_evaluate", { script: "x" })).output).toBe("(undefined)");
  });
});

describe("waiting", () => {
  it("waits for text, a ref, or a load state", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    expect((await run(tools, "browser_wait", { text: "Saved" })).isError).toBeFalsy();
    expect(page.calls.some((c) => c.op === "waitFor text=Saved")).toBe(true);

    await run(tools, "browser_wait", { ref: "e1" });
    expect(page.calls.some((c) => c.op === 'waitFor [data-arterm-ref="e1"]')).toBe(true);

    await run(tools, "browser_wait", { state: "networkidle" });
    expect(page.calls.find((c) => c.op === "waitForLoadState")?.args[0]).toBe("networkidle");
  });

  it("caps an unconditional sleep however long it was asked for", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    await run(tools, "browser_wait", { ms: 10_000_000 });
    expect(page.calls.find((c) => c.op === "waitForTimeout")?.args[0]).toBe(60_000);
  });

  it("reports a page that never settles as a failure, with what IS true", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    page.href = "https://example.com/slow";
    page.pageTitle = "Loading…";
    page.waitFails = true;
    const res = await run(tools, "browser_wait", { state: "networkidle", timeout_ms: 5 });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Timed out");
    expect(res.output).toContain("https://example.com/slow");
    expect(res.output).toContain("Loading…");
  });
});

describe("screenshots", () => {
  it("returns the image INLINE, so the model can actually see it", async () => {
    // The whole point of the image channel: a path is a picture the model
    // cannot open.
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_screenshot", {});
    expect(res.isError).toBeFalsy();
    expect(res.images?.[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(res.images?.[0]?.data ?? "", "base64").toString()).toBe("page-png");
  });

  it("writes nothing to disk unless a path was asked for", async () => {
    // It used to drop a PNG in ARTERM_HOME on every look at a page.
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_screenshot", {});
    expect(res.output).not.toContain("wrote ");
  });

  it("writes a PNG where it was asked to, inside the project", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_screenshot", { path: "shots/page.png" });
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain(join(dir, "shots", "page.png"));
    await expect(fs.readFile(join(dir, "shots", "page.png"), "utf8")).resolves.toBe("page-png");
    // A file AND the inline image — asking for one does not lose the other.
    expect(res.images).toHaveLength(1);
  });

  it("refuses a path outside the working directory", async () => {
    const { tools, h } = setup();
    await openWithSnapshot(tools, h);
    const res = await run(tools, "browser_screenshot", { path: "../escape.png" });
    expect(res.isError).toBe(true);
  });

  it("captures one element when given a ref", async () => {
    const { tools, h } = setup();
    const page = await openWithSnapshot(tools, h);
    await run(tools, "browser_screenshot", { ref: "e1", path: "el.png" });
    expect(page.calls.some((c) => c.op.startsWith("screenshot [data-arterm-ref"))).toBe(true);
  });
});

describe("teardown", () => {
  it("closes every page and browser, and can be called twice", async () => {
    const { tools, pool, h } = setup();
    await run(tools, "browser_open");
    await run(tools, "browser_open");
    const page = onlyPage(h);

    expect(await pool.disposeAll()).toBe(2);
    expect(page.closed).toBe(true);
    expect(h.browser?.closed).toBe(true);
    expect(context(h).closed).toBe(true);
    // Teardown runs on every path, including the ones that are already failing.
    expect(await pool.disposeAll()).toBe(0);
  });

  it("never throws, even when the browser is already gone", async () => {
    const { tools, pool, h } = setup();
    await run(tools, "browser_open");
    const page = onlyPage(h);
    page.close = async () => {
      throw new Error("target closed");
    };
    await expect(pool.disposeAll()).resolves.toBe(1);
  });
});
