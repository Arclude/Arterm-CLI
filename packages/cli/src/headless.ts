import type { TokenUsage } from "@arterm/core";
import type { Session } from "@arterm/tui";
import { ArtermUserError } from "./errors.js";

export interface HeadlessOptions {
  /** Emit a single JSON object instead of streaming plain text to stdout. */
  json?: boolean;
}

/** The structured result printed in `--json` mode. */
export interface HeadlessResult {
  response: string;
  usage?: TokenUsage;
  toolCalls: { name: string }[];
}

/**
 * Run a single prompt to completion without the Ink TUI, for scripting/CI.
 * In plain mode the model's text streams to stdout as it arrives; in `--json`
 * mode the whole turn is buffered and emitted as one object on stdout.
 *
 * Headless can't show an interactive permission prompt, so any tool that would
 * need one is denied (fail-closed, same as the TUI's default). A one-line hint
 * is printed to stderr if that happens and the session isn't in yolo mode.
 */
export async function runHeadless(
  session: Session,
  prompt: string,
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  if (!prompt.trim()) {
    throw new ArtermUserError('No prompt provided. Pass one with --print "…" or pipe it on stdin.');
  }

  let blocked = false;
  session.setAsker(async () => {
    blocked = true;
    return "deny";
  });

  let text = "";
  // Cleaned assistant replies (tool-call JSON already stripped by the response
  // pipeline). The streamed `text_delta` still carries the raw inline tool-call
  // text, so the structured/returned response is built from these instead.
  const replies: string[] = [];
  const toolCalls: { name: string }[] = [];
  let usage: TokenUsage | undefined;
  let errored: string | undefined;

  const unsubscribe = session.bus.on((event) => {
    switch (event.type) {
      case "text_delta":
        text += event.delta;
        if (!opts.json) process.stdout.write(event.delta);
        break;
      case "assistant_message": {
        const clean = event.message.content.trim();
        if (clean) replies.push(clean);
        break;
      }
      case "tool_call":
        toolCalls.push({ name: event.call.name });
        break;
      case "usage":
        usage = event.usage;
        break;
      case "error":
        errored = event.error;
        break;
    }
  });

  try {
    await session.agent.run(prompt);
  } finally {
    unsubscribe();
  }

  // Prefer the cleaned assistant replies; fall back to the raw stream if none were
  // recorded (e.g. a turn that errored before any assistant message).
  const response = replies.length > 0 ? replies.join("\n").trim() : text.trim();
  const result: HeadlessResult = { response, usage, toolCalls };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (text && !text.endsWith("\n")) {
    // Keep the prompt on its own line after streamed output.
    process.stdout.write("\n");
  }

  if (errored) throw new ArtermUserError(errored);

  if (blocked && session.permissionMode !== "yolo") {
    process.stderr.write(
      "Note: some tools were blocked — headless mode can't prompt for permission. " +
        "Re-run with --yolo, or set an auto/yolo permission mode.\n",
    );
  }

  return result;
}
