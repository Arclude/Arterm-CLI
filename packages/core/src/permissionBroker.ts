import type { EventBus } from "./eventBus.js";
import type { PermissionAnswer, PermissionAsker, Tool } from "./types.js";

/**
 * A permission request that is waiting for an answer, in a shape that survives
 * JSON (the host's `Tool` object does not). This is what the desktop status
 * server publishes so a request raised in a background terminal tab can be
 * answered from the GUI.
 */
export interface PendingPermission {
  /** Unique per request; an answer must quote it (guards against stale clicks). */
  id: string;
  tool: string;
  /** The tool's own permission preview — first line summary, rest a diff body. */
  preview: string;
  /** Tool arguments, with long values truncated (see {@link summarizeArgs}). */
  args: Record<string, unknown>;
  category: string;
  riskTier?: string;
  requestedAt: number;
  /** Who is asking, when it isn't the main agent. Absent = the main agent. */
  origin?: PermissionOrigin;
}

/**
 * The sub-agent behind a request. A fan-out shares one asker, so without this a
 * prompt says only "write_file" — and with five same-role sub-agents on the board
 * there is no way to tell which one is blocked. `id` is the board-row id, so a UI
 * can point at the exact row (and colour the prompt to match it).
 */
export interface PermissionOrigin {
  id?: string;
  name: string;
}

/** Who answered a permission request. */
export type PermissionVia = "local" | "remote";

const PREVIEW_MAX = 4000;
const ARG_VALUE_MAX = 500;

/** Cap a preview so a whole-file diff can't bloat every snapshot. */
function truncatePreview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}\n… (truncated)` : text;
}

/**
 * Shallow copy of the tool args with long strings clipped. A `write_file`
 * call can carry a megabyte of content; the GUI only needs enough to decide,
 * and the snapshot is re-sent on every state push.
 */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > ARG_VALUE_MAX) {
      out[key] = `${value.slice(0, ARG_VALUE_MAX)}… (${value.length} chars)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** One queued request: what to show, and how to finish it. */
interface BrokerEntry {
  info: PendingPermission;
  tool: Tool;
  args: Record<string, unknown>;
  resolve: (answer: PermissionAnswer) => void;
}

/**
 * Sits between the agent and whatever UI answers permission prompts, so a
 * request has TWO possible answerers: the local host (the TUI prompt, installed
 * via {@link PermissionBroker.setAsker}) and a remote one (the desktop, via
 * {@link PermissionBroker.answer} on the status server's control endpoint). The
 * first answer wins; the loser is dismissed — the local asker receives an
 * `AbortSignal` so it can tear its prompt down, and its eventual resolution is
 * ignored.
 *
 * Without a broker the CLI's permission flow is unchanged: a host that never
 * calls `answer` sees exactly the old local-only behaviour.
 */
export class PermissionBroker {
  /** Deny until the host installs its real prompt (matches the old default). */
  private inner: PermissionAsker = async () => "deny";
  /** FIFO of requests; the head is the one actually prompted for. */
  private queue: BrokerEntry[] = [];
  /** Set while the head has been handed to the local asker. */
  private active: {
    entry: BrokerEntry;
    settle: (a: PermissionAnswer, via: PermissionVia) => void;
  } | null = null;

  constructor(private readonly bus?: EventBus) {}

  /** Install the local (host UI) asker. */
  setAsker(asker: PermissionAsker): void {
    this.inner = asker;
  }

  /** The request awaiting an answer, if any — folded into the status snapshot. */
  current(): PendingPermission | null {
    return this.active?.entry.info ?? null;
  }

  /** How many further requests are queued behind {@link current}. */
  queuedCount(): number {
    return this.queue.length;
  }

  /** The `PermissionAsker` the agent calls. Never rejects. */
  readonly ask: PermissionAsker = (tool, args) => this.request(tool, args);

  /**
   * An asker that tags every request it raises with `origin`, so the prompt can
   * name the sub-agent behind it. The composition root hands one of these to each
   * dispatched sub-agent; the main agent keeps {@link ask}.
   */
  askFor(origin: PermissionOrigin): PermissionAsker {
    return (tool, args) => this.request(tool, args, origin);
  }

  private request(
    tool: Tool,
    args: Record<string, unknown>,
    origin?: PermissionOrigin,
  ): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve) => {
      // Concurrent asks are real: a fleet of sub-agents shares one asker. Queue
      // them instead of letting a second prompt clobber the first (which used to
      // orphan the first promise and hang that sub-agent forever).
      this.queue.push({
        info: {
          id: `perm-${++PermissionBroker.counter}-${Date.now().toString(36)}`,
          tool: tool.name,
          preview: truncatePreview(tool.preview?.(args) ?? tool.name),
          args: summarizeArgs(args),
          category: tool.category ?? "execute",
          riskTier: tool.riskTier,
          requestedAt: Date.now(),
          ...(origin ? { origin } : {}),
        },
        tool,
        args,
        resolve,
      });
      // Landing behind an active prompt is otherwise a silent event, so announce
      // the depth here as well as on every promotion in `pump`.
      if (this.active) this.announceQueue();
      this.pump();
    });
  }

  /** Publish the current queue depth (see the `permission_queued` event). */
  private announceQueue(): void {
    this.bus?.emit({ type: "permission_queued", queued: this.queue.length });
  }

  /** Promote the queue head to the active prompt, if nothing is active. */
  private pump(): void {
    if (this.active) return;
    const entry = this.queue.shift();
    if (!entry) {
      // Drained: without this the last announced depth would stick around after
      // the final prompt resolves.
      this.announceQueue();
      return;
    }

    const controller = new AbortController();
    let done = false;
    const settle = (answer: PermissionAnswer, via: PermissionVia) => {
      if (done) return;
      done = true;
      this.active = null;
      // Dismiss the loser: the local prompt tears down on abort, and whatever it
      // resolves with afterwards lands back in this same guarded closure.
      controller.abort();
      this.bus?.emit({
        type: "permission_resolved",
        id: entry.info.id,
        tool: entry.info.tool,
        answer,
        via,
      });
      entry.resolve(answer);
      this.pump();
    };

    this.active = { entry, settle };
    this.bus?.emit({
      type: "permission_request",
      id: entry.info.id,
      tool: entry.info.tool,
      preview: entry.info.preview,
      category: entry.info.category,
      riskTier: entry.info.riskTier,
      ...(entry.info.origin ? { origin: entry.info.origin } : {}),
    });
    // The promotion just shortened the queue — keep the counter honest.
    this.announceQueue();

    // A local asker that throws must not wedge the loop — treat it as a deny.
    this.inner(entry.tool, entry.args, controller.signal).then(
      (answer) => settle(answer, "local"),
      () => settle("deny", "local"),
    );
  }

  /**
   * Answer the active request from outside the host UI (the desktop).
   * Quoting a stale/unknown `id` is rejected rather than applied to whatever
   * request happens to be active — a click on a prompt that just resolved
   * locally must never approve the NEXT tool call.
   */
  answer(id: string, answer: PermissionAnswer): { ok: boolean; error?: string } {
    const active = this.active;
    if (!active) return { ok: false, error: "no permission request is pending" };
    if (active.entry.info.id !== id) {
      return { ok: false, error: `stale permission id "${id}" — the pending request changed` };
    }
    active.settle(answer, "remote");
    return { ok: true };
  }

  private static counter = 0;
}
