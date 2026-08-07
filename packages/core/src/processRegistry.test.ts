import { describe, expect, it } from "vitest";
import { redactCommand } from "./credentials.js";
import { ProcessRegistry } from "./processRegistry.js";

/** A child that only records what was done to it. */
function fakeChild(pid = 1234) {
  const killed: Array<NodeJS.Signals | undefined> = [];
  return { handle: { pid, kill: (s?: NodeJS.Signals) => void killed.push(s) }, killed };
}

describe("redactCommand", () => {
  it("leaves an ordinary command untouched", () => {
    expect(redactCommand(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
  });

  it("redacts the value after a credential-named flag", () => {
    expect(redactCommand(["curl", "--token", "sk-real-secret", "https://x"])).toEqual([
      "curl",
      "--token",
      "«redacted»",
      "https://x",
    ]);
  });

  it("redacts the inline form, keeping the name", () => {
    expect(redactCommand(["deploy", "--api-key=sk-real"])).toEqual([
      "deploy",
      "--api-key=«redacted»",
    ]);
    expect(redactCommand(["env", "OPENAI_API_KEY=sk-real", "node", "x.js"])).toEqual([
      "env",
      "OPENAI_API_KEY=«redacted»",
      "node",
      "x.js",
    ]);
  });

  it("redacts an Authorization header, which no name rule would catch", () => {
    expect(redactCommand(["curl", "-H", "Authorization: Bearer sk-real"])).toEqual([
      "curl",
      "-H",
      "Authorization: «redacted»",
    ]);
  });

  it("judges by NAME, never by value — a hash is not a secret", () => {
    // Value-sniffing would eat commit hashes, base64 fixtures and long paths,
    // and a process list nobody can read is a control nobody uses.
    const argv = ["git", "show", "9aaae14c0ffee1234567890abcdef1234567890ab"];
    expect(redactCommand(argv)).toEqual(argv);
    expect(redactCommand(["node", "--max-old-space-size=4096"])).toEqual([
      "node",
      "--max-old-space-size=4096",
    ]);
  });

  it("does not eat a flag whose name merely starts with a credential word", () => {
    // `TOKENIZERS_PARALLELISM` is the case the env rule was built to survive.
    expect(redactCommand(["train", "TOKENIZERS_PARALLELISM=false"])).toEqual([
      "train",
      "TOKENIZERS_PARALLELISM=false",
    ]);
  });
});

describe("ProcessRegistry", () => {
  it("records a redacted label, never the secret", () => {
    const r = new ProcessRegistry();
    const { handle } = fakeChild();
    const rec = r.register(handle, ["curl", "--token", "sk-real-secret"]);
    expect(rec.label).not.toContain("sk-real-secret");
    expect(rec.label).toContain("«redacted»");
    expect(rec.pid).toBe(1234);
    expect(rec.state).toBe("running");
  });

  it("refuses past the cap rather than piling up silently", () => {
    const r = new ProcessRegistry({ max: 2 });
    r.register(fakeChild(1).handle, ["a"]);
    r.register(fakeChild(2).handle, ["b"]);
    expect(() => r.register(fakeChild(3).handle, ["c"])).toThrow(/already running/);
  });

  it("frees a slot when a process ends", () => {
    const r = new ProcessRegistry({ max: 1 });
    const rec = r.register(fakeChild().handle, ["a"]);
    expect(() => r.register(fakeChild().handle, ["b"])).toThrow();
    r.settle(rec.id, 0);
    expect(() => r.register(fakeChild().handle, ["b"])).not.toThrow();
  });

  it("keeps only the TAIL of a process's output", () => {
    // Where a crash says why.
    const r = new ProcessRegistry();
    const rec = r.register(fakeChild().handle, ["a"]);
    r.append(rec.id, "x".repeat(100_000));
    r.append(rec.id, "THE LAST LINE");
    expect(r.get(rec.id)?.output.endsWith("THE LAST LINE")).toBe(true);
    expect(r.get(rec.id)?.output.length ?? 0).toBeLessThanOrEqual(64 * 1024);
  });

  it("kills a running process and records that it was killed", () => {
    const r = new ProcessRegistry();
    const { handle, killed } = fakeChild();
    const rec = r.register(handle, ["server"]);
    expect(r.kill(rec.id)?.state).toBe("killed");
    expect(killed).toEqual(["SIGTERM"]);
    expect(r.get(rec.id)?.endedAt).toBeDefined();
  });

  it("does not re-kill something that already ended", () => {
    const r = new ProcessRegistry();
    const { handle, killed } = fakeChild();
    const rec = r.register(handle, ["a"]);
    r.settle(rec.id, 0);
    r.kill(rec.id);
    expect(killed).toEqual([]);
    expect(r.get(rec.id)?.state).toBe("exited");
  });

  it("killAll reports how many were running, and is idempotent", () => {
    const r = new ProcessRegistry();
    r.register(fakeChild(1).handle, ["a"]);
    r.register(fakeChild(2).handle, ["b"]);
    expect(r.killAll()).toBe(2);
    expect(r.killAll()).toBe(0);
  });

  it("keeps ended processes in the list — the session's record of what it ran", () => {
    const r = new ProcessRegistry();
    const rec = r.register(fakeChild().handle, ["a"]);
    r.settle(rec.id, 3);
    expect(r.list()).toHaveLength(1);
    expect(r.live()).toHaveLength(0);
    expect(r.get(rec.id)?.exitCode).toBe(3);
  });

  it("survives a kill that throws — the process was already gone", () => {
    const r = new ProcessRegistry();
    const rec = r.register(
      {
        pid: 1,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
      ["a"],
    );
    expect(() => r.kill(rec.id)).not.toThrow();
    expect(r.get(rec.id)?.state).toBe("killed");
  });
});
