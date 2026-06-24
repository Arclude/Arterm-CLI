import { describe, expect, it, vi } from "vitest";
import { Container } from "./container.js";
import { Pipeline, createPipelines } from "./pipeline.js";
import { RunController } from "./runController.js";
import { type Token, token } from "./tokens.js";

describe("Container", () => {
  it("lazily builds and memoizes a singleton", () => {
    const tok = token<{ n: number }>("svc");
    const factory = vi.fn(() => ({ n: 1 }));
    const c = new Container();
    c.bind(tok, factory);
    expect(factory).not.toHaveBeenCalled();
    const a = c.resolve(tok);
    const b = c.resolve(tok);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("throws on double bind and on unbound resolve", () => {
    const tok = token<number>("x");
    const c = new Container();
    c.bind(tok, () => 1);
    expect(() => c.bind(tok, () => 2)).toThrow(/already bound/);
    expect(() => c.resolve(token<number>("missing"))).toThrow(/unbound/);
  });

  it("override replaces a binding and clears the cached singleton", () => {
    const tok = token<number>("n");
    const c = new Container();
    c.bind(tok, () => 1);
    expect(c.resolve(tok)).toBe(1);
    c.override(tok, () => 2);
    expect(c.resolve(tok)).toBe(2);
  });

  it("decorate wraps the resolved value", () => {
    const tok = token<number>("n");
    const c = new Container();
    c.bind(tok, () => 10);
    c.decorate(tok, (inner) => inner + 5);
    expect(c.resolve(tok)).toBe(15);
  });

  it("a scope inherits parent bindings but caches its own override", () => {
    const tok = token<number>("n");
    const root = new Container();
    root.bind(tok, () => 1);
    const scope = root.createScope();
    expect(scope.resolve(tok)).toBe(1); // inherited
    scope.override(tok, () => 99);
    expect(scope.resolve(tok)).toBe(99); // local
    expect(root.resolve(tok)).toBe(1); // root untouched
  });
});

describe("Pipeline", () => {
  it("runs middleware onion-style around a shared context", async () => {
    const order: string[] = [];
    const p = new Pipeline<{ value: number }>();
    p.use("a", async (ctx, next) => {
      order.push("a:in");
      ctx.value += 1;
      await next();
      order.push("a:out");
    });
    p.use("b", async (ctx, next) => {
      order.push("b:in");
      ctx.value *= 10;
      await next();
      order.push("b:out");
    });
    const out = await p.run({ value: 1 });
    expect(out.value).toBe(20);
    expect(order).toEqual(["a:in", "b:in", "b:out", "a:out"]);
  });

  it("before/replace/remove address stages by name", async () => {
    const seen: string[] = [];
    const stage = (name: string) => async (_c: unknown, next: () => Promise<void>) => {
      seen.push(name);
      await next();
    };
    const p = new Pipeline<unknown>();
    p.use("core", stage("core"));
    p.before("core", stage("pre"));
    p.replace("core", stage("core2"));
    p.use("extra", stage("extra"));
    p.remove("extra");
    await p.run({});
    expect(seen).toEqual(["pre", "core2"]);
  });

  it("a stage that omits next() short-circuits the chain", async () => {
    const seen: string[] = [];
    const p = new Pipeline<unknown>();
    p.use("stop", async () => {
      seen.push("stop");
    });
    p.use("never", async (_c, next) => {
      seen.push("never");
      await next();
    });
    await p.run({});
    expect(seen).toEqual(["stop"]);
  });

  it("createPipelines builds the six default empty pass-throughs", async () => {
    const reg = createPipelines();
    const ctx = { input: "hi" };
    expect(await reg.userInput.run(ctx)).toBe(ctx); // empty chain is a pass-through
  });
});

describe("RunController", () => {
  it("begins a run with a fresh abort signal and its own scope", () => {
    const tok: Token<number> = token<number>("n");
    const root = new Container();
    root.bind(tok, () => 7);
    const runs = new RunController(root);
    const handle = runs.begin();
    expect(handle.signal.aborted).toBe(false);
    expect(handle.scope.resolve(tok)).toBe(7); // inherited via scope
  });

  it("abort cancels the signal", () => {
    const runs = new RunController(new Container());
    const handle = runs.begin();
    handle.abort("stop");
    expect(handle.signal.aborted).toBe(true);
  });

  it("finish runs teardown disposers LIFO and is idempotent", async () => {
    const runs = new RunController(new Container());
    const handle = runs.begin();
    const order: number[] = [];
    handle.onTeardown(() => {
      order.push(1);
    });
    handle.onTeardown(() => {
      order.push(2);
    });
    await handle.finish();
    await handle.finish(); // idempotent
    expect(order).toEqual([2, 1]);
  });

  it("tracks the iteration limit and the continuation flag", () => {
    const runs = new RunController(new Container());
    const handle = runs.begin();
    expect(handle.getIterationLimit()).toBeUndefined();
    handle.iterationLimit(12);
    expect(handle.getIterationLimit()).toBe(12);
    expect(handle.shouldContinue()).toBe(false);
    handle.requestContinue();
    expect(handle.shouldContinue()).toBe(true);
  });
});
