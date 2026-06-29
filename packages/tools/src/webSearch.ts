import type { Tool } from "@arterm/core";
import { requireString } from "./paths.js";
import { assertSafeUrl } from "./webFetch.js";

/**
 * Keyless web search over DuckDuckGo's HTML endpoint. Returns a ranked list of
 * result titles, URLs, and snippets so the model can pick a page to `web_fetch`.
 * No API key is required; the request goes only to the fixed search host, and
 * each parsed result URL is SSRF-checked before being surfaced.
 */

const ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 20;
const TIMEOUT_MS = 15_000;
// A realistic UA — DuckDuckGo's HTML endpoint returns an empty page to obvious bots.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode a handful of HTML entities and strip tags from a result fragment. */
function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo wraps result links in a redirector: `//duckduckgo.com/l/?uddg=<enc>`.
 * Unwrap it to the real target so the model gets a directly-fetchable URL.
 */
function unwrapHref(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return u.toString();
  } catch {
    return h;
  }
}

/** Parse DuckDuckGo's HTML results page into structured entries. */
export function parseResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result anchor: <a ... class="result__a" href="...">title</a>
  const anchorRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets sit in <a class="result__snippet">…</a>; collect them in order.
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets = [...html.matchAll(snippetRe)].map((m) => cleanText(m[1] ?? ""));

  let i = 0;
  for (const am of html.matchAll(anchorRe)) {
    if (results.length >= limit) break;
    const url = unwrapHref(am[1] ?? "");
    const title = cleanText(am[2] ?? "");
    if (url && title) {
      results.push({ title, url, snippet: snippets[i] ?? "" });
    }
    i++;
  }
  return results;
}

/** Combine the per-request timeout with the agent's abort signal, if present. */
function combinedSignal(ctxSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return ctxSignal ? AbortSignal.any([timeout, ctxSignal]) : timeout;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web (via DuckDuckGo) and return a ranked list of result titles, URLs, " +
    "and snippets. Use this to discover pages, then `web_fetch` a specific URL to read it.",
  permission: "ask",
  category: "execute",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      maxResults: {
        type: "number",
        description: `How many results to return (default ${DEFAULT_MAX_RESULTS}, max ${HARD_MAX_RESULTS}).`,
      },
    },
    required: ["query"],
  },
  preview: (args) => `web_search ${JSON.stringify(String(args.query ?? ""))}`,
  async execute(args, ctx) {
    try {
      const query = requireString(args, "query");
      const limit =
        typeof args.maxResults === "number" && args.maxResults > 0
          ? Math.min(Math.floor(args.maxResults), HARD_MAX_RESULTS)
          : DEFAULT_MAX_RESULTS;

      const url = `${ENDPOINT}?q=${encodeURIComponent(query)}`;
      await assertSafeUrl(url); // fixed host, but keep the egress policy uniform

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
        },
        body: `q=${encodeURIComponent(query)}`,
        signal: combinedSignal(ctx.signal),
      });
      if (!response.ok) {
        return { output: `web_search failed: HTTP ${response.status}`, isError: true };
      }

      const html = await response.text();
      const results = parseResults(html, limit);
      if (results.length === 0) {
        return { output: `No results for "${query}".` };
      }

      const body = results
        .map((r, idx) => {
          const snip = r.snippet ? `\n   ${r.snippet}` : "";
          return `${idx + 1}. ${r.title}\n   ${r.url}${snip}`;
        })
        .join("\n\n");
      return { output: `Search results for "${query}":\n\n${body}` };
    } catch (err) {
      return { output: `web_search failed: ${(err as Error).message}`, isError: true };
    }
  },
};
