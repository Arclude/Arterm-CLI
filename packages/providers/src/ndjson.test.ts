import { describe, expect, it } from "vitest";
import { parseNdjson } from "./ndjson.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseNdjson", () => {
  it("parses whole lines", async () => {
    const out = await collect(parseNdjson(streamOf(['{"a":1}\n{"a":2}\n'])));
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("reassembles objects split across chunks", async () => {
    const out = await collect(parseNdjson(streamOf(['{"a":', "1}\n", '{"b":2}'])));
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("emits a trailing object with no newline", async () => {
    const out = await collect(parseNdjson(streamOf(['{"done":true}'])));
    expect(out).toEqual([{ done: true }]);
  });
});
