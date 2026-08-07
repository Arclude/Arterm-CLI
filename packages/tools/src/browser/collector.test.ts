import { afterEach, describe, expect, it, vi } from "vitest";
import { type CollectOptions, type RawNode, collectSnapshot } from "./collector.js";

/**
 * A DOM small enough to build by hand and large enough for the collector.
 *
 * The collector runs inside a real page, which no machine without a browser
 * binary can provide — so the only way to test the role mapping, the name
 * computation and the ref stamping at all is to hand it a document that answers
 * the dozen methods it actually calls.
 */
class El {
  readonly children: El[] = [];
  parentElement: El | null = null;
  value?: string;
  checked?: boolean;
  checkVisibility?: () => boolean;
  private readonly attrs = new Map<string, string>();

  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    private readonly ownText = "",
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  add(...kids: El[]): this {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
    }
    return this;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
}

/** Just enough selector support for what the collector asks: `[attr]`, `tag[attr="v"]`, `#id`. */
function matches(el: El, selector: string): boolean {
  const attrOnly = /^\[([\w-]+)\]$/.exec(selector);
  if (attrOnly?.[1]) return el.hasAttribute(attrOnly[1]);
  const tagAttr = /^([\w-]*)\[([\w-]+)="(.*)"\]$/.exec(selector);
  if (tagAttr) {
    const [, tag, name, value] = tagAttr;
    if (tag && el.tagName.toUpperCase() !== tag.toUpperCase()) return false;
    return el.getAttribute(name ?? "") === value;
  }
  if (selector.startsWith("#")) return el.getAttribute("id") === selector.slice(1);
  return el.tagName.toUpperCase() === selector.toUpperCase();
}

class Doc {
  constructor(
    readonly body: El,
    public title = "",
  ) {}

  private all(): El[] {
    const out: El[] = [];
    const walk = (el: El): void => {
      out.push(el);
      for (const kid of el.children) walk(kid);
    };
    walk(this.body);
    return out;
  }
  getElementById(id: string): El | null {
    return this.all().find((el) => el.getAttribute("id") === id) ?? null;
  }
  querySelector(selector: string): El | null {
    return this.all().find((el) => matches(el, selector)) ?? null;
  }
  querySelectorAll(selector: string): El[] {
    return this.all().filter((el) => matches(el, selector));
  }
}

function install(doc: Doc, href = "https://example.com/page"): void {
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { href });
}

const options = (over: Partial<CollectOptions> = {}): CollectOptions => ({
  mode: "interactive",
  limit: 100,
  refAttr: "data-arterm-ref",
  startIndex: 1,
  ...over,
});

const byRole = (nodes: RawNode[], role: string): RawNode | undefined =>
  nodes.find((n) => n.role === role);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collectSnapshot", () => {
  it("returns an empty snapshot rather than throwing when there is no document", () => {
    const snap = collectSnapshot(options());
    expect(snap.nodes).toEqual([]);
    expect(snap.total).toBe(0);
  });

  it("maps tags to roles and stamps a ref on each element it reports", () => {
    const body = new El("BODY").add(
      new El("H1", {}, "Sign in"),
      new El("A", { href: "/help" }, "Help"),
      new El("BUTTON", {}, "Go"),
      new El("INPUT", { type: "checkbox" }),
      new El("SELECT"),
    );
    install(new Doc(body, "Login"));

    const snap = collectSnapshot(options());
    expect(snap.nodes.map((n) => n.role)).toEqual([
      "heading",
      "link",
      "button",
      "checkbox",
      "combobox",
    ]);
    expect(snap.nodes.map((n) => n.ref)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(body.children[1]?.getAttribute("data-arterm-ref")).toBe("e2");
    expect(snap.url).toBe("https://example.com/page");
    expect(snap.title).toBe("Login");
    expect(byRole(snap.nodes, "heading")?.level).toBe(1);
    expect(byRole(snap.nodes, "link")?.url).toBe("/help");
    expect(byRole(snap.nodes, "button")?.interactive).toBe(true);
    expect(byRole(snap.nodes, "heading")?.interactive).toBeUndefined();
  });

  it("continues ref numbering from startIndex so an old ref is never re-issued", () => {
    install(new Doc(new El("BODY").add(new El("BUTTON", {}, "One"))));
    const snap = collectSnapshot(options({ startIndex: 42 }));
    expect(snap.nodes[0]?.ref).toBe("e42");
  });

  it("clears the previous snapshot's stamps before making new ones", () => {
    const stale = new El("BUTTON", { "data-arterm-ref": "e1" }, "Old");
    const body = new El("BODY").add(stale, new El("A", { href: "/x" }, "New"));
    install(new Doc(body));

    collectSnapshot(options({ startIndex: 10 }));
    // Both are re-stamped from 10; nothing keeps the identity it had before,
    // which is what stops a ref selector from matching two elements at once.
    expect(stale.getAttribute("data-arterm-ref")).toBe("e10");
    expect(body.children[1]?.getAttribute("data-arterm-ref")).toBe("e11");
  });

  describe("accessible name", () => {
    const nameOf = (el: El, doc?: Doc): string => {
      install(doc ?? new Doc(new El("BODY").add(el)));
      return collectSnapshot(options({ mode: "full" })).nodes[0]?.name ?? "";
    };

    it("prefers aria-label over the element's text", () => {
      expect(nameOf(new El("BUTTON", { "aria-label": "Close dialog" }, "×"))).toBe("Close dialog");
    });

    it("resolves aria-labelledby through the document", () => {
      const label = new El("SPAN", { id: "lbl" }, "Email address");
      const input = new El("INPUT", { "aria-labelledby": "lbl" });
      const doc = new Doc(new El("BODY").add(input, label));
      expect(nameOf(input, doc)).toBe("Email address");
    });

    it("finds a label[for] and falls back to the placeholder", () => {
      const input = new El("INPUT", { id: "email" });
      const doc = new Doc(new El("BODY").add(new El("LABEL", { for: "email" }, "Email"), input));
      expect(nameOf(input, doc)).toBe("Email");
      expect(nameOf(new El("INPUT", { placeholder: "Search docs" }))).toBe("Search docs");
    });

    it("uses an ancestor label when there is no `for`", () => {
      const input = new El("INPUT", {});
      const label = new El("LABEL", {}, "Remember me").add(input);
      const doc = new Doc(new El("BODY").add(label));
      expect(nameOf(input, doc)).toBe("Remember me");
    });

    it("collapses whitespace and clips a very long name", () => {
      const el = new El("BUTTON", {}, `  Save\n\n   changes  ${"x".repeat(300)}`);
      const name = nameOf(el);
      expect(name.startsWith("Save changes")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(120);
    });
  });

  describe("hidden elements", () => {
    const rolesFor = (attrs: Record<string, string>): string[] => {
      const hiddenBox = new El("DIV", attrs).add(new El("BUTTON", {}, "Hidden"));
      install(new Doc(new El("BODY").add(hiddenBox, new El("BUTTON", {}, "Visible"))));
      return collectSnapshot(options()).nodes.map((n) => n.name);
    };

    it("skips a subtree marked aria-hidden, hidden, or display:none", () => {
      expect(rolesFor({ "aria-hidden": "true" })).toEqual(["Visible"]);
      expect(rolesFor({ hidden: "" })).toEqual(["Visible"]);
      expect(rolesFor({ style: "display: none" })).toEqual(["Visible"]);
    });

    it("honours checkVisibility when the browser offers it", () => {
      const invisible = new El("BUTTON", {}, "Painted over");
      invisible.checkVisibility = () => false;
      install(new Doc(new El("BODY").add(invisible, new El("BUTTON", {}, "Real"))));
      expect(collectSnapshot(options()).nodes.map((n) => n.name)).toEqual(["Real"]);
    });

    it("INCLUDES an element whose visibility cannot be determined", () => {
      // Fail-open on purpose: an element wrongly listed can still be clicked and
      // Playwright will say if it is not actionable, but one wrongly omitted is
      // invisible to the model.
      const odd = new El("BUTTON", {}, "Unknown");
      odd.checkVisibility = () => {
        throw new Error("detached");
      };
      install(new Doc(new El("BODY").add(odd)));
      expect(collectSnapshot(options()).nodes.map((n) => n.name)).toEqual(["Unknown"]);
    });
  });

  describe("modes", () => {
    const page = () =>
      new Doc(
        new El("BODY").add(
          new El("DIV", {}).add(
            new El("P", {}, "Some prose about the thing."),
            new El("BUTTON", {}, "Act"),
          ),
        ),
      );

    it("leaves page text out of the interactive mode", () => {
      install(page());
      const snap = collectSnapshot(options());
      expect(snap.nodes.map((n) => n.role)).toEqual(["button"]);
    });

    it("includes leaf text in full mode, but never a wrapper's repeated text", () => {
      install(page());
      const snap = collectSnapshot(options({ mode: "full" }));
      const texts = snap.nodes.filter((n) => n.role === "text");
      // The <div> wraps the <p>; emitting both would put the same prose in the
      // snapshot once per level of nesting.
      expect(texts).toHaveLength(1);
      expect(texts[0]?.name).toBe("Some prose about the thing.");
    });
  });

  it("reports state: value, disabled, and checked", () => {
    const input = new El("INPUT", { type: "text" });
    input.value = "hello";
    const box = new El("INPUT", { type: "checkbox" });
    box.checked = true;
    install(new Doc(new El("BODY").add(input, box, new El("BUTTON", { disabled: "" }, "Off"))));

    const nodes = collectSnapshot(options()).nodes;
    expect(byRole(nodes, "textbox")?.value).toBe("hello");
    expect(byRole(nodes, "checkbox")?.checked).toBe(true);
    expect(byRole(nodes, "button")?.disabled).toBe(true);
  });

  it("counts everything that matched even when the limit cuts the list", () => {
    const body = new El("BODY");
    for (let i = 0; i < 25; i++) body.add(new El("BUTTON", {}, `b${i}`));
    install(new Doc(body));

    const snap = collectSnapshot(options({ limit: 10 }));
    expect(snap.nodes).toHaveLength(10);
    expect(snap.total).toBe(25);
  });

  it("distinguishes a selector that matched nothing from an empty page", () => {
    install(new Doc(new El("BODY").add(new El("BUTTON", {}, "Go"))));
    const missing = collectSnapshot(options({ selector: "#nope" }));
    expect(missing.rootMissing).toBe(true);
    expect(missing.nodes).toEqual([]);

    const found = collectSnapshot(options({ selector: "BODY" }));
    expect(found.rootMissing).toBeUndefined();
    expect(found.nodes).toHaveLength(1);
  });

  it("never descends into script or style", () => {
    install(
      new Doc(
        new El("BODY").add(
          new El("SCRIPT", {}).add(new El("BUTTON", {}, "Not real")),
          new El("BUTTON", {}, "Real"),
        ),
      ),
    );
    expect(collectSnapshot(options()).nodes.map((n) => n.name)).toEqual(["Real"]);
  });
});
