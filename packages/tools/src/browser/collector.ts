/**
 * What the page looks like, collected INSIDE the page.
 *
 * A screenshot is the obvious answer and the wrong one: it costs thousands of
 * tokens, cannot be clicked, and a model reading one still has to guess where
 * the button is. The accessibility tree is the answer — role, name and state,
 * which is exactly what a click needs — so this walks the DOM and returns a flat
 * list of roled nodes, each stamped with a ref the interaction tools resolve.
 *
 * THE WHOLE THING IS ONE SELF-CONTAINED FUNCTION on purpose. Playwright ships it
 * to the page as `fn.toString()`, so nothing outside its own body crosses over:
 * a helper defined at module scope, a constant imported from elsewhere, even a
 * shared regex — all of them become a `ReferenceError` inside the page, at
 * runtime, on someone else's machine. The duplication inside this function is
 * the price of that, and it is worth paying.
 *
 * The DOM types are declared here rather than imported, for the same reason
 * `vendor.ts` declares Playwright's: this package compiles with `lib: ES2023`
 * and no DOM, and narrowing the surface to the dozen methods actually used is
 * what lets the collector run in Node against a fake `document` — the only way
 * any of it is testable on a machine with no browser binary.
 */

/** The slice of an element this walk touches. */
interface DomElement {
  tagName: string;
  children: { length: number; [index: number]: DomElement | undefined };
  parentElement: DomElement | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  value?: unknown;
  checked?: unknown;
  checkVisibility?: () => boolean;
}

/** The slice of the document this walk touches. */
interface DomDocument {
  title?: string;
  body?: DomElement | null;
  getElementById(id: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): { length: number; [index: number]: DomElement | undefined };
}

/** One element worth telling the model about. */
export interface RawNode {
  /** The handle the interaction tools take: `e12`. */
  ref: string;
  role: string;
  name: string;
  /** Nesting depth in the DOM, for rendering the tree. */
  depth: number;
  tag: string;
  value?: string;
  url?: string;
  level?: number;
  disabled?: boolean;
  checked?: boolean;
  /** True when clicking or typing on it is meaningful. */
  interactive?: boolean;
}

export interface RawSnapshot {
  nodes: RawNode[];
  /** How many nodes matched before `limit` cut the list. */
  total: number;
  url: string;
  title: string;
  /** True when `selector` matched nothing — an empty page and a bad selector differ. */
  rootMissing?: boolean;
}

export interface CollectOptions {
  /** "interactive": controls, headings and alerts. "full": everything roled. */
  mode: "interactive" | "full";
  /** Most nodes to return. */
  limit: number;
  /** Optional CSS root; the whole body when absent. */
  selector?: string;
  /** Attribute the refs are stamped into. */
  refAttr: string;
  /**
   * First ref number. Refs never restart, so a ref from an earlier snapshot is
   * never re-issued to a different element — see the note in `pool.ts`.
   */
  startIndex: number;
}

/**
 * Walk the page and return its roled elements, stamping a ref on each.
 *
 * Serialised into the page by Playwright; also called directly, with a fake
 * `document` on `globalThis`, by the tests.
 */
export const collectSnapshot = (options: CollectOptions): RawSnapshot => {
  const global = globalThis as {
    document?: DomDocument;
    location?: { href?: string };
  };
  const doc = global.document;
  const url = global.location?.href ?? "";
  if (!doc) return { nodes: [], total: 0, url, title: "" };

  const out: RawNode[] = [];
  let total = 0;
  let counter = options.startIndex;

  const SKIP = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE"];
  const INTERACTIVE = [
    "link",
    "button",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "slider",
    "spinbutton",
    "switch",
    "menuitem",
    "tab",
    "option",
    "file",
  ];
  // Kept even in the compact mode: a snapshot that is only controls does not say
  // what happened, and "did the form report an error" is the most common
  // question there is after a click.
  const ALWAYS = ["heading", "alert", "status", "dialog"];

  const attr = (el: DomElement, name: string): string => el.getAttribute(name) ?? "";
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 120);

  const roleOf = (el: DomElement): string => {
    const explicit = attr(el, "role").trim().toLowerCase();
    if (explicit) return explicit.split(/\s+/)[0] ?? "";
    const tag = el.tagName.toUpperCase();
    if (tag === "A") return attr(el, "href") ? "link" : "";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const type = (attr(el, "type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "file";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") {
        return "button";
      }
      return "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return "img";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "HEADER") return "banner";
    if (tag === "FOOTER") return "contentinfo";
    if (tag === "ASIDE") return "complementary";
    if (tag === "FORM") return "form";
    if (tag === "DIALOG") return "dialog";
    if (tag === "TABLE") return "table";
    if (tag === "LI") return "listitem";
    if (tag === "OPTION") return "option";
    if (tag === "LABEL") return "label";
    if (tag === "P" || tag === "SPAN" || tag === "DIV" || tag === "TD" || tag === "TH") {
      return "text";
    }
    return "";
  };

  /**
   * An approximation of the accname algorithm: aria-label, aria-labelledby, an
   * associated label, alt/title/placeholder, then visible text. The real
   * algorithm is far longer, and the gap shows up as a name uglier than a screen
   * reader's — never as a name that points at a different element.
   */
  const nameOf = (el: DomElement): string => {
    const label = attr(el, "aria-label");
    if (label.trim()) return clean(label);

    const labelledBy = attr(el, "aria-labelledby");
    if (labelledBy.trim()) {
      const parts: string[] = [];
      for (const id of labelledBy.trim().split(/\s+/)) {
        const target = doc.getElementById(id);
        if (target?.textContent) parts.push(target.textContent);
      }
      if (parts.length > 0) return clean(parts.join(" "));
    }

    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      const id = attr(el, "id");
      if (id) {
        // Quoted, because an id may legitimately contain a colon or a dot,
        // which an unquoted attribute selector reads as syntax.
        const forLabel = doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
        if (forLabel?.textContent?.trim()) return clean(forLabel.textContent);
      }
      let parent: DomElement | null = el.parentElement;
      while (parent) {
        if (parent.tagName.toUpperCase() === "LABEL") {
          if (parent.textContent?.trim()) return clean(parent.textContent);
          break;
        }
        parent = parent.parentElement;
      }
      const placeholder = attr(el, "placeholder");
      if (placeholder.trim()) return clean(placeholder);
    }

    const alt = attr(el, "alt");
    if (alt.trim()) return clean(alt);
    const title = attr(el, "title");
    if (title.trim()) return clean(title);
    return clean(el.textContent ?? "");
  };

  /**
   * Hidden subtrees are skipped, but the FALLBACK IS INCLUDE.
   *
   * `checkVisibility()` is the browser's own answer and is used where it exists;
   * without it only the explicit markers are honoured. The asymmetry is
   * deliberate: an element wrongly listed can still be clicked, and Playwright
   * says plainly when it is not actionable, whereas an element wrongly omitted
   * is invisible — the model cannot ask about something it never saw.
   */
  const hidden = (el: DomElement): boolean => {
    if (attr(el, "aria-hidden") === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    const style = attr(el, "style");
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) return true;
    const check = el.checkVisibility;
    if (typeof check === "function") {
      try {
        return check.call(el) === false;
      } catch {
        return false;
      }
    }
    return false;
  };

  const root: DomElement | null = options.selector
    ? doc.querySelector(options.selector)
    : (doc.body ?? null);
  const title = doc.title ?? "";
  if (!root) {
    return { nodes: [], total: 0, url, title, rootMissing: options.selector !== undefined };
  }

  // Clear the previous snapshot's stamps. Left behind, they accumulate on every
  // snapshot of a long-lived page — and a ref selector that matches two elements
  // is a Playwright strict-mode error rather than a click.
  const stale = doc.querySelectorAll(`[${options.refAttr}]`);
  for (let i = 0; i < stale.length; i++) stale[i]?.removeAttribute(options.refAttr);

  const stack: Array<{ el: DomElement; depth: number }> = [{ el: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const el = current.el;
    const depth = current.depth;
    const tag = el.tagName.toUpperCase();
    if (SKIP.indexOf(tag) !== -1) continue;
    if (hidden(el)) continue;

    const role = roleOf(el);
    const interactive = INTERACTIVE.indexOf(role) !== -1;
    // A "text" role is only emitted for a LEAF. Every wrapper div also has text
    // — its whole subtree's — so emitting non-leaves repeats the page once per
    // level of nesting, which on a real site is the entire budget.
    const isLeafText =
      role !== "text" || (el.children.length === 0 && (el.textContent ?? "").trim() !== "");
    const wanted =
      role !== "" &&
      isLeafText &&
      (options.mode === "full" || interactive || ALWAYS.indexOf(role) !== -1);

    if (wanted) {
      total++;
      if (out.length < options.limit) {
        const ref = `e${counter++}`;
        el.setAttribute(options.refAttr, ref);
        const node: RawNode = { ref, role, name: nameOf(el), depth, tag: tag.toLowerCase() };
        if (interactive) node.interactive = true;
        if (role === "heading") {
          const level = Number(attr(el, "aria-level")) || Number(tag.slice(1));
          if (Number.isFinite(level) && level > 0) node.level = level;
        }
        if (role === "link") {
          const href = attr(el, "href");
          if (href) node.url = href;
        }
        const value = el.value;
        if (typeof value === "string" && value !== "") node.value = clean(value);
        if (el.hasAttribute("disabled") || attr(el, "aria-disabled") === "true") {
          node.disabled = true;
        }
        if (role === "checkbox" || role === "radio" || role === "switch") {
          if (el.checked === true || attr(el, "aria-checked") === "true") node.checked = true;
        }
        out.push(node);
      }
    }

    // Children pushed in reverse so the stack pops them in document order.
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid) stack.push({ el: kid, depth: depth + 1 });
    }
  }

  return { nodes: out, total, url, title };
};
