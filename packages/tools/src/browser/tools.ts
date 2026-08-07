/**
 * The browser tools: fifteen calls over one long-lived browser.
 *
 * The design rests on `browser_snapshot`. A screenshot is what a person would
 * ask for and it is the wrong primitive for a model — it costs thousands of
 * tokens, it cannot be clicked, and acting on it means guessing coordinates. The
 * snapshot returns roles, names and refs, and every interaction tool takes one
 * of those refs, so the loop is: snapshot, act, snapshot again.
 *
 * Lifecycle, egress and ref bookkeeping all live in `pool.ts`; this file is the
 * tool surface over it.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { ARTERM_HOME, type Tool, type ToolResult } from "@arterm/core";
import { optionalString, requireString, resolveWithin } from "../paths.js";
import { BrowserPool, type PageEntry, actionTimeout } from "./pool.js";
import { renderSnapshot } from "./snapshot.js";
import { BROWSER_NAMES, type BrowserName } from "./vendor.js";

/** Nodes a snapshot returns unless asked for more. */
const DEFAULT_SNAPSHOT_LIMIT = 200;
const MAX_SNAPSHOT_LIMIT = 1_000;
/** Ceiling on any explicit wait, however long the model asks for. */
const MAX_WAIT_MS = 60_000;

/**
 * The pool the registered tools use, and the one `disposeBrowsers()` empties.
 * Module-level for the same reason `lsp/tools.ts` keeps its clients there: the
 * whole point is that the browser outlives the call that opened it.
 */
const defaultPool = new BrowserPool();

/** Close every browser this process started. Session teardown calls this. */
export async function disposeBrowsers(): Promise<number> {
  return defaultPool.disposeAll();
}

/**
 * Keep a vendor error readable.
 *
 * Playwright's timeout errors carry a "Call log" of dozens of lines — every
 * retry of the actionability check. Pasted whole into the transcript it costs
 * more than the snapshot that would have explained the problem, and the useful
 * sentence is always the first one.
 */
function clipError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= 3) return lines.join("\n");
  return `${lines.slice(0, 3).join("\n")}\n… (${lines.length - 3} more lines of Playwright call log)`;
}

/** Every tool's outer shell: a thrown error becomes a readable error result. */
async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return { output: clipError(err), isError: true };
  }
}

/**
 * Appended after anything that can change the page.
 *
 * Refs belong to the snapshot that issued them. After a click the DOM may be
 * entirely different, and the failure this prevents is not an error — it is a
 * click that silently lands on whatever now occupies that ref.
 */
const RESNAPSHOT =
  "\n[the page may have changed — take a browser_snapshot before using older refs]";

async function describePage(entry: PageEntry): Promise<string> {
  let title = "";
  try {
    title = await entry.page.title();
  } catch {
    // A page mid-navigation has no title yet; the url alone is still useful.
  }
  return `${entry.page.url()}${title ? ` — "${title}"` : ""}`;
}

function browserArg(args: Record<string, unknown>): BrowserName | undefined {
  const raw = optionalString(args, "browser");
  return raw && (BROWSER_NAMES as string[]).includes(raw) ? (raw as BrowserName) : undefined;
}

/**
 * Wrap the model's script as a function for `page.evaluate`.
 *
 * One rule, stated in the tool's description: the script is a function BODY, so
 * a value comes back via `return`. The exception is the one-liner a model
 * actually writes half the time — `document.title` — which has no `return`, no
 * `;` and no newline, and is wrapped as an expression instead. Both forms are
 * deterministic; guessing per-script whether something is "an expression" is
 * what would make the tool unpredictable.
 */
export function buildEvaluateSource(script: string): string {
  const trimmed = script.trim();
  if (/^(async\s*)?(function\b|\()/.test(trimmed) || /^[^\n;]*=>/.test(trimmed)) {
    return trimmed; // already a function — hand it over untouched
  }
  const simple = !trimmed.includes("\n") && !trimmed.includes(";") && !/\breturn\b/.test(trimmed);
  return simple ? `() => (${trimmed})` : `() => { ${trimmed} }`;
}

/** JSON where possible, a readable string where not. */
function renderValue(value: unknown): string {
  if (value === undefined) return "(undefined)";
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    // Circular, or a value Playwright handed back as a handle.
    return String(value);
  }
}

export function createBrowserTools(pool: BrowserPool = defaultPool): Tool[] {
  const open: Tool = {
    name: "browser_open",
    description:
      "Open a browser tab, optionally at a URL, and return its tab id. The browser stays open " +
      "for the session; every other browser_* tool works on a tab.",
    usageHint:
      "Open once and reuse the tab — a browser costs a second or two to launch and hundreds of " +
      "megabytes to hold, and tabs are capped. Follow every open with browser_snapshot: the tab " +
      "id alone tells you nothing about what is on the page.",
    // Reaches a URL of the model's choosing, which is `web_fetch`'s bargain and
    // gets `web_fetch`'s answer. Nothing here is confined by `sandbox.ts` — the
    // browser is a separate process tree we launch, so the SSRF check in
    // `pool.ts` is the only egress control on this path.
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional http(s) URL to load immediately." },
        browser: {
          type: "string",
          enum: BROWSER_NAMES,
          description: "Engine to launch (default chromium).",
        },
        headless: { type: "boolean", description: "Run without a window (default true)." },
      },
    },
    preview: (args) => `browser_open ${String(args.url ?? "(blank tab)")}`,
    execute: (args) =>
      guarded(async () => {
        const url = optionalString(args, "url");
        const entry = await pool.open({
          ...(browserArg(args) ? { browser: browserArg(args) } : {}),
          ...(typeof args.headless === "boolean" ? { headless: args.headless } : {}),
        });
        if (!url) {
          return { output: `${entry.id} opened (blank). Navigate with browser_navigate.` };
        }
        try {
          await pool.navigate(entry, url);
        } catch (err) {
          // A refused or failed navigation must not leave a blank tab behind.
          // The model retries, and each retry would burn one of the capped slots
          // until `browser_open` began failing for a different reason than the
          // one it actually had.
          await pool.close(entry.id);
          throw err;
        }
        return {
          output: `${entry.id} opened at ${await describePage(entry)}. Take a browser_snapshot to see it.`,
        };
      }),
  };

  const navigate: Tool = {
    name: "browser_navigate",
    description:
      "Load a URL in an open tab. Only http(s) is allowed, and addresses that resolve to " +
      "private, loopback or cloud-metadata ranges are refused.",
    usageHint:
      "Navigation drops the tab's refs, because they named elements in the old document — take a " +
      'fresh browser_snapshot after every navigation. Use `waitUntil: "networkidle"` for a page ' +
      "that renders itself with JavaScript; the default returns as soon as the document loads.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to load." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description: "How far to wait before returning (default load).",
        },
      },
      required: ["url"],
    },
    preview: (args) => `browser_navigate ${String(args.url)}`,
    execute: (args) =>
      guarded(async () => {
        const url = requireString(args, "url");
        const entry = pool.require(optionalString(args, "tab"));
        await pool.navigate(entry, url, optionalString(args, "waitUntil"));
        return { output: `${entry.id} → ${await describePage(entry)}${RESNAPSHOT}` };
      }),
  };

  const snapshot: Tool = {
    name: "browser_snapshot",
    maxOutputBytes: 65_536,
    description:
      "Read the page as an accessibility tree: every element with its role, name, state and a " +
      "ref like [e12]. The refs are what browser_click, browser_type and browser_select take. " +
      "Use this instead of a screenshot — it is the only view you can act on.",
    usageHint:
      'The default mode lists controls, headings and alerts; `mode: "full"` adds the page\'s text, ' +
      "which is how you READ a page rather than drive it. Narrow with `selector` before raising " +
      "`limit`: a scoped snapshot of the form you care about beats a truncated one of the whole " +
      "document. Refs are only valid until the next navigation or snapshot.",
    // Reads the page that is already open — no navigation, no new destination.
    // "read" also keeps it usable in plan mode and inside a sub-agent, whose
    // asker answers "deny" (the `submit_verdict` lesson).
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        mode: {
          type: "string",
          enum: ["interactive", "full"],
          description: "interactive (controls, headings, alerts) or full (adds text).",
        },
        selector: { type: "string", description: "CSS selector to snapshot only that subtree." },
        limit: {
          type: "number",
          description: `Most elements to return (default ${DEFAULT_SNAPSHOT_LIMIT}, max ${MAX_SNAPSHOT_LIMIT}).`,
        },
      },
    },
    preview: (args) => `browser_snapshot ${String(args.selector ?? "(page)")}`,
    execute: (args) =>
      guarded(async () => {
        const entry = pool.require(optionalString(args, "tab"));
        const mode = args.mode === "full" ? "full" : "interactive";
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(Math.floor(args.limit), MAX_SNAPSHOT_LIMIT)
            : DEFAULT_SNAPSHOT_LIMIT;
        const selector = optionalString(args, "selector");
        const snap = await pool.snapshot(entry, {
          mode,
          limit,
          ...(selector ? { selector } : {}),
        });
        return { output: `${entry.id} ${renderSnapshot(snap, { limit, mode })}` };
      }),
  };

  const click: Tool = {
    name: "browser_click",
    description:
      "Click an element by its snapshot ref (e.g. e12). Waits for the element to be actionable.",
    usageHint:
      "The ref must come from the CURRENT snapshot of that tab. If a click reports the element " +
      "is not visible or is covered, snapshot again — the page moved under you, and a second " +
      "click on a stale ref will not help.",
    // A click is a real side effect on someone else's server: it submits forms,
    // it buys things. Same answer as `bash` gets, one tier down — the danger is
    // the site's, not the machine's.
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e12." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
        double: { type: "boolean", description: "Double-click." },
      },
      required: ["ref"],
    },
    preview: (args) => `browser_click ${String(args.ref)}`,
    execute: (args) =>
      guarded(async () => {
        const ref = requireString(args, "ref");
        const entry = pool.require(optionalString(args, "tab"));
        const what = pool.describe(entry, ref);
        const button = optionalString(args, "button");
        await pool.locate(entry, ref).click({
          timeout: actionTimeout(),
          ...(button ? { button } : {}),
          ...(args.double === true ? { clickCount: 2 } : {}),
        });
        return { output: `clicked ${what} on ${entry.id}${RESNAPSHOT}` };
      }),
  };

  const type: Tool = {
    name: "browser_type",
    description:
      "Type text into a field by its snapshot ref. REPLACES the field's current value; set " +
      "submit to press Enter afterwards.",
    usageHint:
      "This fills the field in one step rather than keystroke by keystroke, which is what you " +
      "want except when a page reacts to each key (an autocomplete) — for those, type the stem " +
      "and then use browser_press. Never type a credential you were not explicitly given.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot." },
        text: { type: "string", description: "The text to put in the field." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref", "text"],
    },
    preview: (args) => `browser_type into ${String(args.ref)}`,
    execute: (args) =>
      guarded(async () => {
        const ref = requireString(args, "ref");
        const text = typeof args.text === "string" ? args.text : "";
        const entry = pool.require(optionalString(args, "tab"));
        const what = pool.describe(entry, ref);
        const locator = pool.locate(entry, ref);
        await locator.fill(text, { timeout: actionTimeout() });
        if (args.submit === true) await locator.press("Enter", { timeout: actionTimeout() });
        // The text is echoed back deliberately clipped: a long paste in the
        // result is paid for in the transcript on every later turn.
        const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        return {
          output: `typed "${shown}" into ${what}${args.submit === true ? " and pressed Enter" : ""}${RESNAPSHOT}`,
        };
      }),
  };

  const press: Tool = {
    name: "browser_press",
    description:
      "Press a key (Enter, Escape, Tab, ArrowDown, Control+A, …) — on an element if a ref is " +
      "given, otherwise on whatever has focus.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Key name, e.g. "Enter" or "Control+A".' },
        ref: { type: "string", description: "Optional element ref to press the key on." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
      },
      required: ["key"],
    },
    preview: (args) => `browser_press ${String(args.key)}`,
    execute: (args) =>
      guarded(async () => {
        const key = requireString(args, "key");
        const entry = pool.require(optionalString(args, "tab"));
        const ref = optionalString(args, "ref");
        if (ref) {
          await pool.locate(entry, ref).press(key, { timeout: actionTimeout() });
          return { output: `pressed ${key} on ${pool.describe(entry, ref)}${RESNAPSHOT}` };
        }
        await entry.page.keyboard.press(key, { timeout: actionTimeout() });
        return { output: `pressed ${key} on ${entry.id}${RESNAPSHOT}` };
      }),
  };

  const select: Tool = {
    name: "browser_select",
    description: "Choose one or more options in a <select> by its snapshot ref.",
    usageHint:
      "Values are the option VALUES, not their visible labels — take a snapshot with " +
      'mode "full" to see the options, whose names are the labels and whose values are what ' +
      "this takes.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref of the <select>." },
        values: {
          type: "array",
          items: { type: "string" },
          description: "Option values to select.",
        },
        value: { type: "string", description: "A single option value (shorthand for values)." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
      },
      required: ["ref"],
    },
    preview: (args) => `browser_select on ${String(args.ref)}`,
    execute: (args) =>
      guarded(async () => {
        const ref = requireString(args, "ref");
        const single = optionalString(args, "value");
        const values = Array.isArray(args.values)
          ? args.values.map(String).filter((v) => v !== "")
          : single
            ? [single]
            : [];
        if (values.length === 0) {
          return { output: "Give `value` or a non-empty `values` array.", isError: true };
        }
        const entry = pool.require(optionalString(args, "tab"));
        const chosen = await pool
          .locate(entry, ref)
          .selectOption(values, { timeout: actionTimeout() });
        // Playwright returns what it actually selected; a value the <select>
        // does not have selects nothing, which is silent unless it is reported.
        const got = Array.isArray(chosen) ? chosen : [];
        if (got.length === 0) {
          return {
            output: `Selected nothing in ${pool.describe(entry, ref)} — no option matched ${values.join(", ")}.`,
            isError: true,
          };
        }
        return {
          output: `selected ${got.join(", ")} in ${pool.describe(entry, ref)}${RESNAPSHOT}`,
        };
      }),
  };

  const drag: Tool = {
    name: "browser_drag",
    description: "Drag one element onto another, both given as snapshot refs.",
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Ref of the element to drag." },
        to: { type: "string", description: "Ref of the drop target." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
      },
      required: ["from", "to"],
    },
    preview: (args) => `browser_drag ${String(args.from)} → ${String(args.to)}`,
    execute: (args) =>
      guarded(async () => {
        const from = requireString(args, "from");
        const to = requireString(args, "to");
        const entry = pool.require(optionalString(args, "tab"));
        const source = pool.locate(entry, from);
        const target = pool.locate(entry, to);
        await source.dragTo(target, { timeout: actionTimeout() });
        return {
          output: `dragged ${pool.describe(entry, from)} onto ${pool.describe(entry, to)}${RESNAPSHOT}`,
        };
      }),
  };

  const upload: Tool = {
    name: "browser_upload",
    description:
      "Attach local files to a file input, given the input's snapshot ref. Paths are relative " +
      "to the working directory and cannot escape it.",
    usageHint:
      "The ref must be the file input itself (role `file`), not the styled button in front of " +
      "it — a snapshot shows both, and clicking the button opens a native dialog no tool can " +
      "answer.",
    // Confinement matters more here than in most file tools: this SENDS what it
    // reads to a remote site, so an unconfined path is an exfiltration primitive
    // rather than a read. `resolveWithin` is the same guard `read` uses, for a
    // consequence one step worse.
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref of the file input." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to attach, relative to the working directory.",
        },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
      },
      required: ["ref", "paths"],
    },
    preview: (args) =>
      `browser_upload ${Array.isArray(args.paths) ? args.paths.length : 0} file(s) → ${String(args.ref)}`,
    execute: (args, ctx) =>
      guarded(async () => {
        const ref = requireString(args, "ref");
        const raw = Array.isArray(args.paths) ? args.paths.map(String) : [];
        if (raw.length === 0) {
          return { output: "browser_upload needs a non-empty `paths` array.", isError: true };
        }
        const entry = pool.require(optionalString(args, "tab"));
        const resolved = raw.map((rel) => resolveWithin(ctx.cwd, rel));
        for (const abs of resolved) {
          try {
            await fs.access(abs);
          } catch {
            return { output: `No such file: ${abs}`, isError: true };
          }
        }
        await pool.locate(entry, ref).setInputFiles(resolved, { timeout: actionTimeout() });
        return {
          output: `attached ${resolved.length} file(s) to ${pool.describe(entry, ref)}${RESNAPSHOT}`,
        };
      }),
  };

  const evaluate: Tool = {
    name: "browser_evaluate",
    maxOutputBytes: 32_768,
    description:
      "Run JavaScript in the page and return its result. Your script is a function BODY — use " +
      "`return` to send a value back (a bare one-line expression is returned for you).",
    usageHint:
      "Reach for a snapshot first: this is the escape hatch for what the accessibility tree " +
      "cannot express (a computed style, a canvas, an app's own state), not the normal way to " +
      "read a page. Whatever you return is serialised as JSON, so return plain values — a DOM " +
      "node comes back as an empty object.",
    // The most dangerous tool in this family, and graded as such. The page is an
    // AUTHENTICATED context: `document.cookie`, `localStorage` and same-origin
    // `fetch()` are all reachable from one line, so a script can read a live
    // session and post it somewhere. The sandbox does not reach this — the
    // request leaves from the browser, not from our process — so `pool.ts`'s
    // route guard is the only thing between a script and the network, and it
    // only knows addresses, not intent.
    //
    // "destructive" rather than "caution" is what makes `confirmDestructive`
    // re-prompt for it even under auto and yolo, which is the same treatment
    // `bash` gets and for the same reason: this is the arbitrary-code tool.
    permission: "ask",
    category: "execute",
    mutating: true,
    riskTier: "destructive",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript to run in the page." },
        tab: { type: "string", description: "Tab id (default: the active tab)." },
      },
      required: ["script"],
    },
    preview: (args) => `browser_evaluate ${String(args.script ?? "").slice(0, 60)}`,
    execute: (args) =>
      guarded(async () => {
        const script = requireString(args, "script");
        const entry = pool.require(optionalString(args, "tab"));
        const value = await entry.page.evaluate<unknown>(buildEvaluateSource(script));
        return { output: renderValue(value) };
      }),
  };

  const wait: Tool = {
    name: "browser_wait",
    description:
      "Wait for the page to settle, for text to appear, for an element to be visible, or for a " +
      "fixed number of milliseconds.",
    usageHint:
      "Prefer waiting for TEXT or a REF over a fixed sleep: a sleep is either too short on a " +
      "slow day or wasted on a fast one. A wait that times out is reported as a failure with " +
      "the page's current state, which is usually the more interesting answer.",
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        text: { type: "string", description: "Wait until this text is visible." },
        ref: { type: "string", description: "Wait until this element is visible." },
        state: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "Wait for this load state (default load).",
        },
        ms: { type: "number", description: "Wait this many milliseconds, unconditionally." },
        timeout_ms: {
          type: "number",
          description: `How long to wait for text/ref/state (max ${MAX_WAIT_MS}).`,
        },
      },
    },
    preview: (args) => {
      if (args.text) return `browser_wait for text "${String(args.text).slice(0, 40)}"`;
      if (args.ref) return `browser_wait for ${String(args.ref)}`;
      if (typeof args.ms === "number") return `browser_wait ${args.ms}ms`;
      return `browser_wait for ${String(args.state ?? "load")}`;
    },
    execute: (args) =>
      guarded(async () => {
        const entry = pool.require(optionalString(args, "tab"));
        const timeout = Math.min(
          typeof args.timeout_ms === "number" && args.timeout_ms > 0
            ? Math.floor(args.timeout_ms)
            : actionTimeout(),
          MAX_WAIT_MS,
        );
        const started = Date.now();
        const text = optionalString(args, "text");
        const ref = optionalString(args, "ref");

        if (typeof args.ms === "number" && args.ms > 0) {
          const ms = Math.min(Math.floor(args.ms), MAX_WAIT_MS);
          await entry.page.waitForTimeout(ms);
          return { output: `waited ${ms}ms on ${entry.id}` };
        }

        try {
          if (text) {
            await entry.page.getByText(text).waitFor({ state: "visible", timeout });
            return {
              output: `"${text}" is visible on ${entry.id} after ${Date.now() - started}ms`,
            };
          }
          if (ref) {
            await pool.locate(entry, ref).waitFor({ state: "visible", timeout });
            return {
              output: `${pool.describe(entry, ref)} is visible after ${Date.now() - started}ms`,
            };
          }
          const state = optionalString(args, "state") ?? "load";
          await entry.page.waitForLoadState(state, { timeout });
          return { output: `${entry.id} reached "${state}" after ${Date.now() - started}ms` };
        } catch (err) {
          // A page that never settles is the normal case here, not an anomaly —
          // an advertising iframe alone can keep `networkidle` unreachable
          // forever. Reported as a failure WITH the current state, because
          // "waited, and here is what is true now" is what the model needs, and
          // a silent success would have it act on a page that never arrived.
          return {
            output: `Timed out after ${Date.now() - started}ms. ${entry.id} is at ${await describePage(entry)}.\n${clipError(err)}`,
            isError: true,
          };
        }
      }),
  };

  const screenshot: Tool = {
    name: "browser_screenshot",
    description:
      "Save a PNG of the page (or of one element) to disk and return its path. Use " +
      "browser_snapshot to READ a page — this is for showing a human what it looks like.",
    // NOTE: this writes a file and hands back a path because `ToolResult` has no
    // image channel yet. When `ToolResult.images` lands, the image should be
    // returned INLINE from here — the path is a stand-in, and a model that
    // cannot see the picture is being told where a picture it cannot open is.
    // Until then the honest framing is in the description: reading is
    // `browser_snapshot`'s job, and this is for a person.
    permission: "ask",
    category: "edit",
    mutating: true,
    riskTier: "caution",
    parameters: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        ref: { type: "string", description: "Ref of one element to capture, instead of the page." },
        path: {
          type: "string",
          description: "Where to write the PNG, relative to the working directory.",
        },
        fullPage: { type: "boolean", description: "Capture the whole scrollable page." },
      },
    },
    preview: (args) => `browser_screenshot ${String(args.path ?? "(default path)")}`,
    execute: (args, ctx) =>
      guarded(async () => {
        const entry = pool.require(optionalString(args, "tab"));
        const rel = optionalString(args, "path");
        // An explicit path is confined to the project; the default goes to
        // ARTERM_HOME, which keeps a debugging screenshot out of the repository
        // (and out of whatever the model commits next).
        const target = rel
          ? resolveWithin(ctx.cwd, rel)
          : join(ARTERM_HOME, "screenshots", `${Date.now()}-${entry.id}.png`);
        await fs.mkdir(dirname(target), { recursive: true });
        const ref = optionalString(args, "ref");
        if (ref) {
          await pool.locate(entry, ref).screenshot({ path: target, timeout: actionTimeout() });
        } else {
          await entry.page.screenshot({
            path: target,
            timeout: actionTimeout(),
            ...(args.fullPage === true ? { fullPage: true } : {}),
          });
        }
        return { output: `wrote ${target}` };
      }),
  };

  const list: Tool = {
    name: "browser_list",
    description: "List the open browser tabs with their ids, URLs and titles.",
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: { type: "object", properties: {} },
    preview: () => "browser_list",
    execute: () =>
      guarded(async () => {
        const tabs = pool.list();
        if (tabs.length === 0) {
          return { output: "No browser tabs are open. Open one with browser_open." };
        }
        const lines: string[] = [];
        for (const entry of tabs) {
          const mark = entry.id === pool.active ? "*" : " ";
          const refs = entry.refs.size > 0 ? ` · ${entry.refs.size} refs` : " · no snapshot";
          lines.push(`${mark} ${entry.id}: ${await describePage(entry)}${refs}`);
        }
        return { output: `${lines.join("\n")}\n[* = the tab other browser_* calls default to]` };
      }),
  };

  const status: Tool = {
    name: "browser_status",
    description:
      "Report whether browser automation is available on this machine, what is launched, and " +
      "what is open. Ask this first when a browser tool fails for an unclear reason.",
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: { type: "object", properties: {} },
    preview: () => "browser_status",
    execute: () =>
      guarded(async () => {
        // Deliberately does not launch anything: the whole point is to answer
        // "why did that fail" without paying for a browser to find out.
        const probe = await pool.probe();
        const engine = pool.engine;
        const tabs = pool.list();
        const lines = [
          probe.ok ? "playwright: installed" : `playwright: unavailable — ${probe.reason}`,
          engine
            ? `engine: ${engine.name} (${engine.headless ? "headless" : "headed"}), running`
            : "engine: nothing launched yet",
          `tabs: ${tabs.length} open${tabs.length > 0 ? ` (${tabs.map((t) => t.id).join(", ")})` : ""}`,
          `timeouts: ${actionTimeout()}ms per action`,
        ];
        return { output: lines.join("\n") };
      }),
  };

  const close: Tool = {
    name: "browser_close",
    description:
      "Close one tab, or every tab and the browser itself with all=true. Close what you are " +
      "finished with — a browser holds hundreds of megabytes.",
    // Closing is how a session gets its memory back, so it must not be the call
    // that stops to ask. It changes nothing outside this process.
    permission: "allow",
    category: "execute",
    mutating: true,
    riskTier: "safe",
    parameters: {
      type: "object",
      properties: {
        tab: { type: "string", description: "Tab id (default: the active tab)." },
        all: { type: "boolean", description: "Close every tab and quit the browser." },
      },
    },
    preview: (args) =>
      args.all === true
        ? "browser_close all"
        : `browser_close ${String(args.tab ?? "(active tab)")}`,
    execute: (args) =>
      guarded(async () => {
        if (args.all === true) {
          const n = await pool.disposeAll();
          return { output: n === 0 ? "Nothing was open." : `Closed ${n} tab(s) and the browser.` };
        }
        const entry = pool.require(optionalString(args, "tab"));
        await pool.close(entry.id);
        const left = pool.list().length;
        return { output: `Closed ${entry.id}. ${left} tab(s) still open.` };
      }),
  };

  return [
    open,
    navigate,
    snapshot,
    click,
    type,
    press,
    select,
    drag,
    upload,
    evaluate,
    wait,
    screenshot,
    list,
    status,
    close,
  ];
}

/** The registered set, over the process-wide pool. */
export const browserTools: Tool[] = createBrowserTools();

/** Tool names in this family, for rosters that filter by name. */
export const BROWSER_TOOL_NAMES = browserTools.map((t) => t.name);
