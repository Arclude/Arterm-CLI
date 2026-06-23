import { lookup } from "node:dns/promises";
import type { Tool } from "@arterm/core";
import { requireString } from "./paths.js";

/**
 * SSRF guard. Tools that fetch remote URLs must never be tricked into reaching
 * the host's own loopback, the private network the host sits on, or cloud
 * metadata endpoints. `isBlockedAddress` is the pure, network-free classifier
 * (so it is unit-testable) and `assertSafeUrl` ties it to protocol + DNS checks.
 */

/** Parse a dotted IPv4 string into its four octets, or null if malformed. */
function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty, non-numeric, leading-zero ambiguity, or out-of-range.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** True for an IPv4 address (given as octets) that must never be fetched. */
function isBlockedIPv4(o: [number, number, number, number]): boolean {
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Normalize an IPv6 string into its full list of 16-bit hextets, expanding any
 * `::` shorthand. Returns null when the literal cannot be parsed.
 */
function parseIPv6(ip: string): number[] | null {
  let str = ip;
  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) becomes two trailing hextets.
  const v4Match = str.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[1]!);
    if (!v4) return null;
    const high = (v4[0] << 8) | v4[1];
    const low = (v4[2] << 8) | v4[3];
    str = `${str.slice(0, v4Match.index)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;

  const toHextets = (segment: string): number[] | null => {
    if (segment === "") return [];
    const out: number[] = [];
    for (const piece of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const all = toHextets(halves[0]!);
    return all && all.length === 8 ? all : null;
  }

  const head = toHextets(halves[0]!);
  const tail = toHextets(halves[1]!);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/** True for an IPv6 address (given as 8 hextets) that must never be fetched. */
function isBlockedIPv6(h: number[]): boolean {
  if (h.length !== 8) return true; // malformed -> treat as unsafe
  const isZero = (n: number, count: number) => h.slice(0, count).every((x) => x === n);

  // ::1 loopback and :: unspecified.
  if (h[7] === 1 && isZero(0, 7)) return true;
  if (h.every((x) => x === 0)) return true;

  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible — defer to IPv4 rules.
  if (isZero(0, 5) && h[5] === 0xffff) {
    const a = (h[6]! >> 8) & 0xff;
    const b = h[6]! & 0xff;
    const c = (h[7]! >> 8) & 0xff;
    const d = h[7]! & 0xff;
    return isBlockedIPv4([a, b, c, d]);
  }
  return false;
}

/**
 * True when the given IP literal points at an address the agent must not reach:
 * loopback, private, link-local, CGNAT, "this host", reserved, and multicast
 * ranges — for both IPv4 and IPv6 (incl. IPv4-mapped `::ffff:a.b.c.d`).
 */
export function isBlockedAddress(ip: string): boolean {
  const trimmed = ip.trim().replace(/^\[/, "").replace(/\]$/, "");
  const v4 = parseIPv4(trimmed);
  if (v4) return isBlockedIPv4(v4);
  if (trimmed.includes(":")) {
    const v6 = parseIPv6(trimmed);
    if (!v6) return true; // unparseable IPv6 literal -> block
    return isBlockedIPv6(v6);
  }
  // Not an IP literal at all; caller resolves it via DNS separately.
  return false;
}

/** True when a hostname is itself an IP literal (vs. a name needing DNS). */
function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  return parseIPv4(h) !== null || h.includes(":");
}

/**
 * Parse `url`, enforce http(s), and verify every address it points at is safe.
 * IP literals are checked directly; hostnames are DNS-resolved and rejected if
 * *any* returned address is blocked. Returns the parsed URL on success.
 */
export async function assertSafeUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${parsed.protocol}" — only http and https are allowed.`);
  }

  const host = parsed.hostname;
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`Refusing to fetch a private/internal address: ${host}`);
    }
    return parsed;
  }

  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (records.length === 0) {
    throw new Error(`Could not resolve host: ${host}`);
  }
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new Error(`Host ${host} resolves to a private/internal address (${address}).`);
    }
  }
  return parsed;
}

const DEFAULT_MAX_BYTES = 100_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

/** Strip HTML to readable-ish plain text: drop script/style, remove tags, collapse space. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Combine the per-request timeout with the agent's abort signal, if present. */
function combinedSignal(ctxSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!ctxSignal) return timeout;
  // AbortSignal.any merges sources; the first to fire aborts the fetch.
  return AbortSignal.any([timeout, ctxSignal]);
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL over http(s) and return its readable text content (HTML is stripped " +
    "to plain text). Blocks private, loopback, and other internal addresses for safety, " +
    "re-checking every redirect hop.",
  permission: "ask",
  category: "execute",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch." },
      maxBytes: {
        type: "number",
        description: `Maximum number of bytes to read from the body (default ${DEFAULT_MAX_BYTES}).`,
      },
    },
    required: ["url"],
  },
  preview: (args) => `web_fetch ${String(args.url)}`,
  async execute(args, ctx) {
    try {
      const startUrl = requireString(args, "url");
      const maxBytes =
        typeof args.maxBytes === "number" && args.maxBytes > 0
          ? Math.floor(args.maxBytes)
          : DEFAULT_MAX_BYTES;

      const signal = combinedSignal(ctx.signal);

      // Follow redirects manually so each hop's target is re-validated for SSRF.
      let current = await assertSafeUrl(startUrl);
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetch(current, { redirect: "manual", signal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break; // 3xx with no Location — treat as final.
          const next = new URL(location, current);
          current = await assertSafeUrl(next.toString());
          if (hop === MAX_REDIRECTS) {
            return { output: `Too many redirects (>${MAX_REDIRECTS}).`, isError: true };
          }
          continue;
        }
        break;
      }
      if (!response) {
        return { output: "No response received.", isError: true };
      }

      // Read at most maxBytes from the body without buffering the whole thing.
      const reader = response.body?.getReader();
      let raw = new Uint8Array(0);
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
        }
        await reader.cancel().catch(() => {});
        raw = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          raw.set(c, offset);
          offset += c.length;
        }
        if (raw.length > maxBytes) raw = raw.subarray(0, maxBytes);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(raw);
      const isHtml = /\bhtml\b/i.test(contentType) || /^\s*<(?:!doctype|html)\b/i.test(decoded);
      const body = isHtml ? htmlToText(decoded) : decoded.trim();

      const header = `# ${current.toString()} (${response.status})`;
      return { output: `${header}\n\n${body}`.trim() };
    } catch (err) {
      return { output: `web_fetch failed: ${(err as Error).message}`, isError: true };
    }
  },
};
