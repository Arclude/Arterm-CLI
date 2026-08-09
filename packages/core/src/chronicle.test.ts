import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Chronicle,
  type ChronicleChange,
  type ChronicleRecord,
  type ChronicleSink,
  GENESIS_HASH,
  chronicleToolCall,
  stableStringify,
  verifyChain,
} from "./chronicle.js";
import { Pipeline } from "./kernel/pipeline.js";
import type { ToolCallCtx } from "./kernel/pipeline.js";
import type { DiffRow, Tool } from "./types.js";
import type { WorkspaceWatcher } from "./workspaceWatch.js";

/** Collects sealed records the way a real sink would receive them. */
function collector(): { sink: ChronicleSink; records: ChronicleRecord[] } {
  const records: ChronicleRecord[] = [];
  return { sink: { write: (r) => void records.push(r) }, records };
}

describe("stableStringify", () => {
  it("is key-order independent — the chain must not depend on how a record was built", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("drops undefined members rather than encoding them", () => {
    // An optional field that is absent and one that is explicitly undefined are
    // the same record; if they hashed differently, adding an optional field to
    // the envelope would break every chain written before it.
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("keeps array position, encoding a hole as null", () => {
    expect(stableStringify([1, undefined, 2])).toBe("[1,null,2]");
  });
});

describe("the chain", () => {
  it("anchors at the genesis hash and links each record to the last", () => {
    const { sink, records } = collector();
    const chronicle = new Chronicle(sink);
    chronicle.append({ eventType: "tool.executed", outcome: "success", scope: {} });
    chronicle.append({ eventType: "tool.executed", outcome: "failure", scope: {} });

    expect(records[0]?.previousHash).toBe(GENESIS_HASH);
    expect(records[1]?.previousHash).toBe(records[0]?.hash);
    expect(records.map((r) => r.sequence)).toEqual([1, 2]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it("catches a record whose CONTENTS were edited after it was written", () => {
    // The case the whole design exists for: someone rewrites what a run did.
    const { sink, records } = collector();
    const chronicle = new Chronicle(sink);
    chronicle.append({
      eventType: "tool.executed",
      outcome: "success",
      scope: {},
      toolName: "write",
    });
    chronicle.append({ eventType: "tool.executed", outcome: "success", scope: {} });

    const tampered = records.map((r) => ({ ...r }));
    const first = tampered[0];
    if (!first) throw new Error("no record to tamper with");
    first.toolName = "read";
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain("contents changed");
  });

  it("catches a record REMOVED from the middle, which edits nothing", () => {
    // Deletion is the subtle one: every surviving record still hashes to its
    // own contents, so only the link between them can tell.
    const { sink, records } = collector();
    const chronicle = new Chronicle(sink);
    for (const name of ["read", "write", "bash"]) {
      chronicle.append({
        eventType: "tool.executed",
        outcome: "success",
        scope: {},
        toolName: name,
      });
    }
    const result = verifyChain([records[0], records[2]] as ChronicleRecord[]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.brokenAt).toBe(3);
  });

  it("survives a sink that throws — the run outranks its own ledger", () => {
    const chronicle = new Chronicle({
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() =>
      chronicle.append({ eventType: "tool.executed", outcome: "success", scope: {} }),
    ).not.toThrow();
    // …and the chain still advances, so an unwritable disk cannot be mistaken
    // for an edited ledger later.
    const second = chronicle.append({ eventType: "tool.executed", outcome: "success", scope: {} });
    expect(second.sequence).toBe(2);
  });

  it("an empty ledger verifies rather than erroring", () => {
    expect(verifyChain([])).toEqual({
      ok: true,
      entries: 0,
      lastSequence: 0,
      lastHash: GENESIS_HASH,
    });
  });
});

describe("the toolCall stage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "arterm-chronicle-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (
    ctx: ToolCallCtx,
    inner: (ctx: ToolCallCtx) => void | Promise<void>,
  ): Promise<ChronicleRecord[]> => {
    const { sink, records } = collector();
    const pipeline = new Pipeline<ToolCallCtx>();
    pipeline.use(
      "chronicle",
      chronicleToolCall(new Chronicle(sink), () => dir),
    );
    pipeline.use("execute", async (c, next) => {
      await inner(c);
      await next();
    });
    await pipeline.run(ctx);
    return records;
  };

  const diff = (added: number, removed: number): DiffRow[] => [
    ...Array.from({ length: added }, () => ({ kind: "add" as const, text: "+" })),
    ...Array.from({ length: removed }, () => ({ kind: "del" as const, text: "-" })),
    { kind: "context" as const, text: " " },
  ];

  it("records the file's hash FROM DISK, not the tool's word for it", async () => {
    // The point of the ledger: `path` and `diff` come from the tool, but the
    // digest is read back off the filesystem, so a tool that reports a change
    // it did not make is contradicted by its own record.
    await fs.writeFile(join(dir, "a.ts"), "after\n");
    const records = await run({ call: { id: "c1", name: "write", arguments: {} } }, (c) => {
      c.tool = { name: "write" } as ToolCallCtx["tool"];
      c.path = "a.ts";
      c.diff = diff(2, 1);
    });

    expect(records).toHaveLength(1);
    const change = records[0]?.change;
    expect(change?.path).toBe("a.ts");
    expect(change?.added).toBe(2);
    expect(change?.removed).toBe(1);
    // The literal sha256 of the bytes on disk, not a shape check: a digest
    // assertion that only says "64 hex characters" passes for the wrong file.
    expect(change?.contentHashAfter).toBe(
      "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919",
    );
    expect(records[0]?.outcome).toBe("success");
  });

  it("says the file is GONE rather than reporting it unchanged", async () => {
    // A delete and a no-op are the same diff from the tool's side; only the
    // missing digest tells them apart.
    const records = await run({ call: { id: "c2", name: "write", arguments: {} } }, (c) => {
      c.tool = { name: "write" } as ToolCallCtx["tool"];
      c.path = "never-written.ts";
    });
    expect(records[0]?.change?.contentHashAfter).toBeUndefined();
  });

  it("records a DENIED call, which is what a summary forgets", async () => {
    // The permission stage short-circuits by never setting `tool`; the ledger
    // has to show the attempt, because "I was not allowed to" is a fact about
    // the run that its own narration reliably drops.
    const records = await run({ call: { id: "c3", name: "bash", arguments: {} } }, () => {
      /* permission denied: no tool resolved, nothing executed */
    });
    expect(records[0]?.eventType).toBe("tool.denied");
    expect(records[0]?.outcome).toBe("denied");
    expect(records[0]?.change).toBeUndefined();
  });

  it("records a failing tool as a failure, and still writes the record", async () => {
    const records = await run({ call: { id: "c4", name: "read", arguments: {} } }, (c) => {
      c.tool = { name: "read" } as ToolCallCtx["tool"];
      c.isError = true;
    });
    expect(records[0]?.outcome).toBe("failure");
  });

  it("stamps the worker's identity, so a fan-out says WHO changed the file", async () => {
    // The question a fan-out makes hard. A ledger that answered it with one
    // session id would be no better than the summary it replaces.
    const { sink, records } = collector();
    const chronicle = new Chronicle(sink, () => ({ sessionId: "s1" }));
    const pipeline = new Pipeline<ToolCallCtx>();
    pipeline.use(
      "chronicle",
      chronicleToolCall(
        chronicle,
        () => dir,
        () => ({ agentId: "tester" }),
      ),
    );
    pipeline.use("execute", async (c, next) => {
      c.tool = { name: "write" } as ToolCallCtx["tool"];
      await next();
    });
    await pipeline.run({ call: { id: "c6", name: "write", arguments: {} } });

    // Both, not either: the worker is named without losing which run it was in.
    expect(records[0]?.scope.agentId).toBe("tester");
    expect(records[0]?.scope.sessionId).toBe("s1");
  });

  it("still records when the tool throws past the stage", async () => {
    // `finally`, not a happy path: a crashed tool is the run's most interesting
    // moment, and it is the one a ledger written after `next()` would lose.
    const { sink, records } = collector();
    const pipeline = new Pipeline<ToolCallCtx>();
    pipeline.use(
      "chronicle",
      chronicleToolCall(new Chronicle(sink), () => dir),
    );
    pipeline.use("execute", async () => {
      throw new Error("tool exploded");
    });
    await expect(pipeline.run({ call: { id: "c5", name: "bash", arguments: {} } })).rejects.toThrow(
      "tool exploded",
    );
    expect(records).toHaveLength(1);
  });
});

/**
 * The shell's writes, which no tool declares.
 *
 * `bash` returns a string and names no path, so `describeChange` had nothing to
 * describe and the run's most prolific writer left no trace — while the judge
 * reads this ledger against the claim, and an empty one reads as "wrote
 * nothing". A fake watcher stands in for git here: the git implementation has
 * its own tests against a real repo, and what these pin is the SEAM.
 */
describe("the toolCall stage with a workspace watcher", () => {
  const watcher = (changes: ChronicleChange[], skipped = 0): WorkspaceWatcher => ({
    snapshot: async () => ({
      root: "/repo",
      witnesses: [],
      paths: new Set<string>(),
      states: new Map(),
      numstat: new Map(),
      skippedPaths: new Set<string>(),
      skipped: 0,
    }),
    changesSince: async () => ({ changes, skipped, concurrent: [] }),
  });

  const run = async (
    ctx: ToolCallCtx,
    w: WorkspaceWatcher,
    category: "read" | "execute" = "execute",
  ): Promise<ChronicleRecord[]> => {
    const { sink, records } = collector();
    const pipeline = new Pipeline<ToolCallCtx>();
    pipeline.use(
      "chronicle",
      chronicleToolCall(
        new Chronicle(sink),
        () => "/repo",
        () => ({}),
        // The roster the gate consults. It has to come from here rather than
        // from `ctx.tool`, which the permission stage sets AFTER this one runs.
        { watcher: w, tools: () => [{ name: ctx.call.name, category } as Tool] },
      ),
    );
    pipeline.use("execute", async (c, next) => {
      c.tool = { name: c.call.name, category } as ToolCallCtx["tool"];
      await next();
    });
    await pipeline.run(ctx);
    return records;
  };

  const observed = (records: ChronicleRecord[]) =>
    records.filter((r) => r.eventType === "file.observed");

  it("records what a command changed, though the tool declared nothing", async () => {
    const records = await run(
      { call: { id: "c1", name: "bash", arguments: { command: "sed -i s/a/b/ x.ts" } } },
      watcher([{ path: "x.ts", added: 3, removed: 1, contentHashAfter: "abc" }]),
    );
    const files = observed(records);
    expect(files).toHaveLength(1);
    expect(files[0]?.change?.path).toBe("x.ts");
    expect(files[0]?.change?.contentHashAfter).toBe("abc");
    // The provenance is on the record: a measured change is weaker evidence
    // than a tool's account of its own write, and the ledger says which it is.
    expect(files[0]?.attributes?.observedBy).toBe("git");
  });

  it("keeps the execution count honest when one call writes several files", async () => {
    // The reason these are their own records rather than a list on the call's:
    // three files must not read as three tool calls.
    const records = await run(
      { call: { id: "c1", name: "bash", arguments: {} } },
      watcher([
        { path: "a.ts", added: 1, removed: 0 },
        { path: "b.ts", added: 2, removed: 0 },
        { path: "c.ts", added: 3, removed: 0 },
      ]),
    );
    expect(records.filter((r) => r.eventType === "tool.executed")).toHaveLength(1);
    expect(observed(records)).toHaveLength(3);
  });

  it("does not pay the watcher on a read-category tool", async () => {
    // Two git calls and a digest of the dirty set per `grep` is the cost this
    // gate exists to refuse.
    let looked = false;
    const counting: WorkspaceWatcher = {
      ...watcher([]),
      snapshot: async () => {
        looked = true;
        return undefined;
      },
    };
    await run({ call: { id: "c1", name: "grep", arguments: {} } }, counting, "read");
    expect(looked).toBe(false);
  });

  it("states the truncation rather than dropping it silently", async () => {
    const records = await run({ call: { id: "c1", name: "bash", arguments: {} } }, watcher([], 12));
    const call = records.find((r) => r.eventType === "tool.executed");
    expect(call?.attributes?.observedTruncated).toBe(12);
  });

  it("still chains: every observed file advances the hash chain", async () => {
    // The records are ordinary members of the ledger, not an annex — a deleted
    // one has to break verification like any other.
    const records = await run(
      { call: { id: "c1", name: "bash", arguments: {} } },
      watcher([{ path: "a.ts", added: 1, removed: 0, contentHashAfter: "h" }]),
    );
    expect(verifyChain(records).ok).toBe(true);
    expect(verifyChain([records[0] as ChronicleRecord]).ok).toBe(true);
    expect(records.map((r) => r.sequence)).toEqual([1, 2]);
  });
});
