/**
 * Wraps the stdout handed to Ink with two rendering fixes Ink 5 lacks:
 *
 * - **Synchronized, coalesced repaints.** All writes issued in the same tick
 *   (Ink repaints a commit as erase → static → frame, up to three writes) are
 *   buffered and flushed as ONE write wrapped in DEC synchronized output
 *   (`ESC[?2026h` … `ESC[?2026l`). The terminal holds painting until the whole
 *   frame has arrived, so the footer can never be seen half-erased — the
 *   classic Ink flicker. (Ink gained this natively in v6.7; we're on v5, and
 *   patching the dependency wouldn't reach npm installs.)
 *
 * - **Scrollback protection.** When Ink's dynamic frame ever reaches the
 *   terminal height it emits ansi-escapes' clearTerminal (`ESC[2J ESC[3J
 *   ESC[H`); the `ESC[3J` erases the terminal's SCROLLBACK — the chat history
 *   we deliberately committed there. That exact sequence is rewritten without
 *   its `3J`. A deliberate wipe can still be requested by emitting `3J` first
 *   (see /clear), which this filter leaves alone.
 *
 * Everything else (rows/columns getters, resize events, isTTY) passes through
 * to the real stream.
 */

const ESC = String.fromCharCode(27);
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
/** ansi-escapes' clearTerminal, as emitted by Ink's full-repaint path. */
const INK_CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`;
const SAFE_CLEAR = `${ESC}[2J${ESC}[H`;

export function syncedStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  let buf: string[] = [];
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (buf.length === 0) return;
    const chunk = buf.join("");
    buf = [];
    real.write(`${SYNC_START}${chunk}${SYNC_END}`);
  };

  const write = (chunk: unknown): boolean => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    buf.push(s.split(INK_CLEAR).join(SAFE_CLEAR));
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    return true;
  };

  return new Proxy(real, {
    get(target, prop) {
      if (prop === "write") return write;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as NodeJS.WriteStream;
}
