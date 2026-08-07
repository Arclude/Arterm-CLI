/**
 * JSON-RPC over a language server's stdio.
 *
 * LSP frames every message with a `Content-Length` header and a blank line,
 * then that many BYTES of UTF-8. Two details are where naive implementations
 * break, and both are why this is its own tested file rather than a few lines
 * inside the client:
 *
 * - The length is in bytes, not characters. A diagnostic mentioning a symbol
 *   with an em-dash or a CJK identifier is longer in bytes than in characters,
 *   and a character-counting reader desynchronises from that message onward —
 *   every later reply is then garbage, which looks like the server crashed.
 * - A read from a pipe is not a message. One chunk can hold three replies, or
 *   half a header; the buffer is drained in a loop and only when a complete
 *   frame is present.
 */

import type { Readable, Writable } from "node:stream";

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const HEADER_END = "\r\n\r\n";

/** Split a stream of bytes into LSP frames. Pure, so the framing is testable alone. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  /** Feed a chunk; get back every complete message it completed. */
  push(chunk: Buffer): RpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: RpcMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) return out;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        // A header with no length is unrecoverable — the stream position of the
        // next message is unknowable. Drop the header and try to resynchronise
        // rather than spin on the same bytes forever.
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + HEADER_END.length;
      if (this.buffer.length < start + length) return out; // frame not complete yet
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        out.push(JSON.parse(body) as RpcMessage);
      } catch {
        // A malformed body is one lost message, not a lost connection.
      }
    }
  }
}

/** Encode one message as an LSP frame. */
export function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${HEADER_END}${body}`;
}

export interface PendingError extends Error {
  code?: number;
}

/**
 * A request/response connection over one server's stdio.
 *
 * Every request carries a timeout. A language server that stops answering is
 * the common failure — it is indexing, or it is confused by a half-written file
 * — and a tool call that never returns is worse than one that says "the server
 * did not answer in time", because the turn simply ends.
 */
export class RpcConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }
  >();
  private notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private reader = new FrameReader();
  private closed = false;

  constructor(
    private input: Writable,
    output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => {
      for (const message of this.reader.push(chunk)) this.dispatch(message);
    });
    output.on("close", () => this.fail(new Error("the language server closed its output")));
  }

  private dispatch(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (message.error) {
        const err: PendingError = new Error(message.error.message);
        err.code = message.error.code;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
  }

  /** Called when the process dies: nothing will answer, so settle everything. */
  fail(err: Error): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.input.write(frame({ jsonrpc: "2.0", method, params }));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("the language server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(frame({ jsonrpc: "2.0", id, method, params }));
    });
  }

  dispose(): void {
    this.fail(new Error("the connection was closed"));
  }
}
