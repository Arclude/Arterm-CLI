import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { syncedStdout } from "./syncOutput.js";

const ESC = String.fromCharCode(27);
const tick = (): Promise<void> => new Promise((r) => queueMicrotask(() => r()));

function fakeTty(): NodeJS.WriteStream & { chunks: string[] } {
  const em = new EventEmitter() as unknown as NodeJS.WriteStream & { chunks: string[] };
  em.chunks = [];
  Object.assign(em, {
    isTTY: true,
    rows: 24,
    columns: 80,
    write: (c: string) => {
      em.chunks.push(String(c));
      return true;
    },
  });
  return em;
}

describe("syncedStdout", () => {
  it("coalesces same-tick writes into one synchronized-output write", async () => {
    const real = fakeTty();
    const wrapped = syncedStdout(real);
    wrapped.write("erase");
    wrapped.write("static");
    wrapped.write("frame");
    expect(real.chunks).toHaveLength(0); // nothing hits the tty mid-repaint
    await tick();
    expect(real.chunks).toHaveLength(1);
    expect(real.chunks[0]).toBe(`${ESC}[?2026herasestaticframe${ESC}[?2026l`);
  });

  it("flushes separate ticks as separate synchronized frames", async () => {
    const real = fakeTty();
    const wrapped = syncedStdout(real);
    wrapped.write("one");
    await tick();
    wrapped.write("two");
    await tick();
    expect(real.chunks).toHaveLength(2);
    expect(real.chunks[1]).toBe(`${ESC}[?2026htwo${ESC}[?2026l`);
  });

  it("strips the scrollback wipe from Ink's clearTerminal sequence", async () => {
    const real = fakeTty();
    const wrapped = syncedStdout(real);
    wrapped.write(`${ESC}[2J${ESC}[3J${ESC}[Hrepaint`);
    await tick();
    expect(real.chunks[0]).toContain(`${ESC}[2J${ESC}[H`);
    expect(real.chunks[0]).not.toContain(`${ESC}[3J`);
  });

  it("leaves a deliberate 3J-first wipe (our /clear) untouched", async () => {
    const real = fakeTty();
    const wrapped = syncedStdout(real);
    wrapped.write(`${ESC}[3J${ESC}[2J${ESC}[H`);
    await tick();
    expect(real.chunks[0]).toContain(`${ESC}[3J`);
  });

  it("proxies terminal properties and events to the real stream", () => {
    const real = fakeTty();
    const wrapped = syncedStdout(real);
    expect(wrapped.rows).toBe(24);
    expect(wrapped.columns).toBe(80);
    expect(wrapped.isTTY).toBe(true);
    let resized = 0;
    wrapped.on("resize", () => {
      resized += 1;
    });
    (real as unknown as EventEmitter).emit("resize");
    expect(resized).toBe(1);
  });
});
