import { describe, expect, it } from "vitest";
import { OSC52_MAX_CHARS, copyToClipboard, osc52Sequence } from "./clipboard.js";

const PREFIX = "]52;c;";
const BEL = "";

describe("osc52Sequence", () => {
  it("wraps base64 utf-8 text in an OSC 52 clipboard sequence", () => {
    const seq = osc52Sequence("merhaba ✓");
    expect(seq.startsWith(PREFIX)).toBe(true);
    expect(seq.endsWith(BEL)).toBe(true);
    const b64 = seq.slice(PREFIX.length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("merhaba ✓");
  });

  it("caps oversized payloads", () => {
    const seq = osc52Sequence("x".repeat(OSC52_MAX_CHARS + 5000));
    const b64 = seq.slice(PREFIX.length, -1);
    expect(Buffer.from(b64, "base64").toString("utf8")).toHaveLength(OSC52_MAX_CHARS);
  });
});

describe("copyToClipboard (OS helper first, OSC 52 fallback)", () => {
  /** Fake spawner: records invocations; succeeds only for `works`. */
  function spawner(works: string[]) {
    const calls: Array<{ cmd: string; fed: string }> = [];
    const fn = (cmd: string, _args: string[]) => {
      const call = { cmd, fed: "" };
      calls.push(call);
      const handlers = new Map<string, (arg?: unknown) => void>();
      queueMicrotask(() => {
        if (works.includes(cmd)) handlers.get("close")?.(0);
        else handlers.get("error")?.(new Error("ENOENT"));
      });
      return {
        stdin: {
          write: (s: string) => {
            call.fed += s;
          },
          end: () => {},
        },
        on: (event: "error" | "close", cb: (arg?: unknown) => void) => {
          handlers.set(event, cb);
        },
      };
    };
    return { calls, fn };
  }

  it("uses wl-copy on Wayland and feeds it the text", async () => {
    const { calls, fn } = spawner(["wl-copy"]);
    const method = await copyToClipboard("panoya", {
      tty: true,
      env: { WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      spawner: fn,
    });
    expect(method).toBe("wl-copy");
    expect(calls).toEqual([{ cmd: "wl-copy", fed: "panoya" }]);
  });

  it("falls through a missing helper to the next, then to OSC 52", async () => {
    const { fn } = spawner([]); // every helper fails (not installed)
    const writes: string[] = [];
    const method = await copyToClipboard("metin", {
      tty: true,
      env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      platform: "linux",
      spawner: fn,
      stdout: { write: (s: string) => writes.push(s) },
    });
    expect(method).toBe("osc52");
    expect(writes.join("")).toContain("52;c;");
  });

  it("skips OS helpers entirely without a TTY (tests, pipes)", async () => {
    const { calls, fn } = spawner(["wl-copy"]);
    const writes: string[] = [];
    const method = await copyToClipboard("x", {
      tty: false,
      env: { WAYLAND_DISPLAY: "wayland-0" },
      spawner: fn,
      stdout: { write: (s: string) => writes.push(s) },
    });
    expect(method).toBe("osc52");
    expect(calls).toEqual([]);
  });

  it("prefers OSC 52 over SSH — a local helper would set the WRONG clipboard", async () => {
    const { calls, fn } = spawner(["wl-copy"]);
    const writes: string[] = [];
    const method = await copyToClipboard("uzak", {
      tty: true,
      env: { WAYLAND_DISPLAY: "wayland-0", SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" },
      spawner: fn,
      stdout: { write: (s: string) => writes.push(s) },
    });
    expect(method).toBe("osc52");
    expect(calls).toEqual([]);
  });

  it("reports none when no route exists instead of pretending", async () => {
    const { fn } = spawner([]);
    const method = await copyToClipboard("x", { tty: true, env: {}, spawner: fn });
    expect(method).toBe("none");
  });
});
