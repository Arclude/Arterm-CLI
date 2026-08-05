/**
 * An ordered chain of models that answers as one provider.
 *
 * Retry and replay both re-send the *same* request to the *same* endpoint, which
 * cannot help when that endpoint is the problem: a rate limit that won't clear
 * for an hour, an overloaded model, a provider outage. The chain is the next
 * escalation — move to a different model, and if configured, a different vendor.
 *
 * Two rules keep it honest:
 *
 *  - **Only on a retryable failure.** A dead API key or a malformed request will
 *    be rejected by every target too; burning the whole chain on it would turn
 *    one clear error into a slow, confusing one. See `ProviderError.retryable`.
 *  - **Only before output.** Once text or a tool call has reached the caller,
 *    switching models would splice two different answers together. The turn
 *    fails instead, exactly as it does for stream replay.
 */

import {
  type ChatChunk,
  type ChatProvider,
  type ChatRequest,
  type ModelInfo,
  type ProviderErrorKind,
  type RateLimitSnapshot,
  isAbortError,
  normalizeProviderError,
} from "@arterm/core";

export interface FallbackTarget {
  provider: ChatProvider;
  /**
   * Model to request from this provider. Omitted on the primary, which follows
   * whatever model the caller asked for — so `/model` keeps working normally and
   * only the fallbacks are pinned.
   */
  model?: string;
}

/** What the chain reports when it moves on, for the event bus / UI. */
export interface FallbackNotice {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: ProviderErrorKind;
  detail: string;
}

export interface FallbackOptions {
  /** Called just before each switch — wire this to the event bus. */
  onFallback?: (notice: FallbackNotice) => void;
}

/**
 * Wraps an ordered list of targets and presents them as a single `ChatProvider`.
 * A single-target chain behaves exactly like the bare provider.
 */
export class FallbackChatProvider implements ChatProvider {
  private readonly targets: readonly FallbackTarget[];
  private readonly onFallback: ((notice: FallbackNotice) => void) | undefined;

  constructor(targets: readonly FallbackTarget[], opts: FallbackOptions = {}) {
    if (targets.length === 0) throw new Error("FallbackChatProvider needs at least one target");
    this.targets = targets;
    this.onFallback = opts.onFallback;
  }

  /** The primary's identity — this chain stands in for it everywhere. */
  get id(): string {
    return this.primary.provider.id;
  }

  private get primary(): FallbackTarget {
    // Non-null: the constructor rejects an empty list.
    return this.targets[0] as FallbackTarget;
  }

  /**
   * Answered by the primary. A fallback target that disagrees still works: the
   * response pipeline recovers JSON-shaped tool calls from the text body, which
   * is the same path a non-native model takes normally.
   */
  supportsNativeTools(model: string): boolean | Promise<boolean> {
    return this.primary.provider.supportsNativeTools(model);
  }

  /** The primary's catalog — the pinned fallback models are not offered as choices. */
  listModels(): Promise<ModelInfo[]> {
    return this.primary.provider.listModels();
  }

  /**
   * The freshest report across the chain. Not just the primary's: after a
   * fallback, the target actually answering is the one whose quota matters.
   */
  rateLimits(): RateLimitSnapshot | undefined {
    let best: RateLimitSnapshot | undefined;
    for (const t of this.targets) {
      const snap = t.provider.rateLimits?.();
      if (snap && (!best || snap.at > best.at)) best = snap;
    }
    return best;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let lastError: unknown;

    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i] as FallbackTarget;
      const model = target.model ?? req.model;
      let emitted = false;

      try {
        for await (const chunk of target.provider.chat({ ...req, model })) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (isAbortError(err) || req.signal?.aborted) throw err;
        const error = normalizeProviderError(err, target.provider.id);
        lastError = error;

        const next = this.targets[i + 1];
        if (emitted || !error.retryable || !next) throw error;

        this.onFallback?.({
          from: { provider: target.provider.id, model },
          to: { provider: next.provider.id, model: next.model ?? req.model },
          reason: error.kind,
          detail: error.message.split("\n")[0] ?? error.message,
        });
      }
    }

    // Unreachable: the final target either returns or throws above.
    throw lastError;
  }
}

/**
 * Build a chain, or hand back the provider untouched when nothing is configured
 * — so the no-fallback path keeps exactly its previous behavior and cost.
 */
export function withFallbacks(
  primary: ChatProvider,
  fallbacks: readonly FallbackTarget[],
  opts: FallbackOptions = {},
): ChatProvider {
  if (fallbacks.length === 0) return primary;
  return new FallbackChatProvider([{ provider: primary }, ...fallbacks], opts);
}
