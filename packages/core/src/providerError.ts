/**
 * One typed error for every provider failure.
 *
 * Without this, a transport hiccup and a wrong API key both arrive at the agent
 * loop as a bare `Error` with an opaque message, so nothing above the provider
 * can tell "retry this" from "retrying can never help" — and a `TypeError:
 * terminated` from a dropped socket ends the whole turn as if the model had
 * refused.
 */

/**
 * Why a provider call failed. The kind — not the status — decides whether a
 * retry has any chance, so a transport failure with no HTTP response at all
 * (`status: 0`) is still classified.
 */
export type ProviderErrorKind =
  | "network" // socket died / DNS / connection refused — no answer was received
  | "timeout" // the server accepted but never finished (idle guard, 408)
  | "auth" // 401/403 — credentials, not luck
  | "quota" // 429 or a usage-limit body — retry after the hinted delay
  | "overloaded" // 503/529 — the model is busy, not broken
  | "server" // any other 5xx
  | "bad_request" // 4xx we caused (bad schema, oversized context)
  | "unknown";

/** Kinds where trying the exact same request again is meaningful. */
const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  "network",
  "timeout",
  "quota",
  "overloaded",
  "server",
]);

export interface ProviderErrorInit {
  /** Provider id (`anthropic`, `ollama`, …) — prefixed onto the message. */
  provider: string;
  kind: ProviderErrorKind;
  /** HTTP status, or 0 when the failure happened before/instead of a response. */
  status?: number;
  /** Raw `Retry-After` header value, when the server sent one. */
  retryAfter?: string | null;
  /** The original throwable, kept for debugging. */
  cause?: unknown;
}

/**
 * `Retry-After` as milliseconds — `null` when absent or unparseable.
 *
 * The header comes in two shapes (RFC 9110): delta-seconds, or an HTTP date.
 * One parser lives here because two layers act on the answer — the retry loop
 * decides whether waiting is worth it, and the error message tells the user how
 * long the server intends to keep refusing.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(trimmed) - now;
  if (Number.isFinite(dateMs) && dateMs > 0) return dateMs;
  return null;
}

/** "45s" / "12m" / "1h 5m" — for a hint a human reads, not for arithmetic. */
export function formatWait(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * A provider failure with enough structure to route on.
 *
 * Prefer {@link ProviderError.is} over `instanceof`: a globally installed
 * `arterm` alongside a workspace build can load two copies of this module, and
 * `instanceof` silently returns false across that boundary — the exact failure
 * that makes retry and fallback quietly stop working.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: string | null;
  /** {@link retryAfter} parsed to ms — how long the server says it will keep refusing. */
  readonly retryAfterMs: number | null;

  constructor(message: string, init: ProviderErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.retryable = RETRYABLE_KINDS.has(init.kind);
    this.retryAfter = init.retryAfter ?? null;
    this.retryAfterMs = parseRetryAfter(this.retryAfter);
  }

  /** Structural check — survives duplicate copies of this module (see class doc). */
  static is(err: unknown): err is ProviderError {
    if (err instanceof ProviderError) return true;
    if (typeof err !== "object" || err === null) return false;
    const e = err as Partial<ProviderError>;
    return (
      e.name === "ProviderError" &&
      typeof e.status === "number" &&
      typeof e.retryable === "boolean" &&
      typeof e.kind === "string"
    );
  }
}

/**
 * Whether a failed stream can be re-issued from scratch.
 *
 * Only a dead socket qualifies: the request never produced a usable response, so
 * sending it again cannot duplicate output. A timeout is deliberately excluded —
 * replaying it would just buy another full idle window against a server that has
 * already proven it isn't answering.
 */
export function isReplayable(err: ProviderError): boolean {
  return err.kind === "network";
}

/** Cancellation (user abort or idle guard) — never a provider failure. */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Transport-level failures that surface as an opaque `TypeError` from `fetch`. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * `fetch` reports a mid-stream socket death as `TypeError: terminated` with the
 * real reason buried in `cause`. Walk the cause chain for a recognizable code or
 * one of undici's `UND_ERR_*` families.
 */
function networkCodeOf(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"))) {
      return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Message shapes undici/Node use when the connection dies without a code. */
const NETWORK_MESSAGES = [
  /\bterminated\b/i,
  /fetch failed/i,
  /socket hang up/i,
  /premature close/i,
  /other side closed/i,
];

function isNetworkError(err: unknown): boolean {
  if (networkCodeOf(err) !== undefined) return true;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && NETWORK_MESSAGES.some((re) => re.test(message));
}

/** Map an HTTP status onto the kind that decides retryability. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "quota";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** What the user can actually do about it, appended to the message. */
function hintFor(kind: ProviderErrorKind, provider: string, waitMs: number | null): string {
  // A sub-second Retry-After (servers do send `0`) is not news — quoting it turns
  // an actionable hint into "left alone for another 0s".
  const wait = waitMs !== null && waitMs >= 1000 ? formatWait(waitMs) : null;
  switch (kind) {
    case "auth":
      return `Check the credentials for ${provider} — \`arterm auth set ${provider}\`, or \`arterm login\` for a subscription.`;
    case "quota":
      return wait
        ? `Rate limited — ${provider} asked to be left alone for another ${wait}. Configure \`fallbackModels\` to switch models automatically, or use /model.`
        : "Rate limited or out of quota — the request was retried and still refused.";
    case "overloaded":
      return `The model is overloaded${wait ? ` for another ${wait}` : ""}; try again shortly or switch models with /model.`;
    case "network":
      return "The connection dropped before the response completed.";
    case "timeout":
      return "The server accepted the request but stopped sending data.";
    case "bad_request":
      return "The request was rejected as invalid — this usually means an oversized context or an unsupported parameter.";
    default:
      return "";
  }
}

function compose(
  provider: string,
  kind: ProviderErrorKind,
  detail: string,
  waitMs: number | null = null,
): string {
  const hint = hintFor(kind, provider, waitMs);
  const head = `${provider}: ${detail}`;
  return hint ? `${head}\n${hint}` : head;
}

/**
 * Build a ProviderError from a non-ok response. Consumes the body for detail,
 * so call this only on a response you are abandoning.
 */
export async function providerErrorFromResponse(
  provider: string,
  res: Response,
  context: string,
): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  const kind = kindForStatus(res.status);
  const retryAfter = res.headers.get("retry-after");
  const detail = `${context} failed: HTTP ${res.status}${body ? ` ${truncate(body)}` : ""}`;
  return new ProviderError(compose(provider, kind, detail, parseRetryAfter(retryAfter)), {
    provider,
    kind,
    status: res.status,
    retryAfter,
  });
}

/** Keep a giant HTML error page out of the transcript. */
function truncate(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Coerce anything thrown by a provider call into a `ProviderError`.
 *
 * Callers must check {@link isAbortError} first and rethrow — a cancelled run is
 * not a failed one, and turning it into a retryable error would make Esc retry
 * the request it just cancelled.
 */
export function normalizeProviderError(err: unknown, provider: string): ProviderError {
  if (ProviderError.is(err)) return err;

  // The stream idle guard aborts with a plain Error, not an AbortError, because
  // it is our own deadline rather than the caller's cancellation.
  if (/stream idle/i.test(messageOf(err))) {
    return new ProviderError(compose(provider, "timeout", messageOf(err)), {
      provider,
      kind: "timeout",
      cause: err,
    });
  }

  // SDK errors (e.g. @anthropic-ai/sdk APIError) carry a numeric status.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status > 0) {
    const kind = kindForStatus(status);
    const retryAfter = headerRetryAfter(err);
    return new ProviderError(compose(provider, kind, messageOf(err), parseRetryAfter(retryAfter)), {
      provider,
      kind,
      status,
      retryAfter,
      cause: err,
    });
  }

  if (isNetworkError(err)) {
    const code = networkCodeOf(err);
    const detail = code ? `${messageOf(err)} (${code})` : messageOf(err);
    return new ProviderError(compose(provider, "network", detail), {
      provider,
      kind: "network",
      cause: err,
    });
  }

  return new ProviderError(compose(provider, "unknown", messageOf(err)), {
    provider,
    kind: "unknown",
    cause: err,
  });
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * `Retry-After` off an SDK error's response headers.
 *
 * SDKs expose them as a `Headers`, a plain object, or not at all depending on
 * version, so this reads both shapes rather than assuming one — losing the header
 * only downgrades the message, which makes a wrong assumption easy to miss.
 */
function headerRetryAfter(err: unknown): string | null {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== "object") return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (get as (name: string) => unknown).call(headers, "retry-after");
    return typeof value === "string" ? value : null;
  }
  const value = (headers as Record<string, unknown>)["retry-after"];
  return typeof value === "string" ? value : null;
}
