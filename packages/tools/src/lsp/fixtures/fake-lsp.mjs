#!/usr/bin/env node
/**
 * A language server that only pretends.
 *
 * The same reason `scripts/fault-server.mjs` exists for the model provider: the
 * failure modes that matter here — a server that never answers, one that
 * publishes no diagnostics, one that returns an edit outside the working
 * directory — are the ones a real server almost never produces on demand. A
 * real `typescript-language-server` proves the protocol is right; this proves
 * the client survives the protocol going wrong.
 *
 * Behaviour is chosen by argv:
 *   --mode ok        answers everything (default)
 *   --mode silent    initializes, then never answers a request
 *   --mode nodiag    answers requests but publishes no diagnostics
 *   --mode slowdiag  publishes an EMPTY set on open, the real one shortly after
 *                    (what typescript-language-server does before its project
 *                    is loaded — a client that takes the first push calls
 *                    broken code clean)
 *   --mode escape    returns a rename edit pointing outside the root
 *   --mode crash     exits as soon as it is initialized
 */

const args = process.argv.slice(2);
const mode = args[(args.indexOf("--mode") ?? -1) + 1] ?? "ok";

let buffer = Buffer.alloc(0);
const documents = new Map();

/** Every whole-word occurrence of `word` in `text`, as LSP ranges. */
function rangesOf(text, word) {
  const out = [];
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  text.split("\n").forEach((line, row) => {
    let m = re.exec(line);
    while (m) {
      out.push({
        start: { line: row, character: m.index },
        end: { line: row, character: m.index + word.length },
      });
      m = re.exec(line);
    }
    re.lastIndex = 0;
  });
  return out;
}

/** The identifier at a position, so rename can behave like a real server. */
function wordAt(text, position) {
  const line = text.split("\n")[position.line] ?? "";
  const before = /[A-Za-z_$][\w$]*$/.exec(line.slice(0, position.character + 1));
  const after = /^[\w$]*/.exec(line.slice(position.character + 1));
  return `${before?.[0] ?? ""}${after?.[0] ?? ""}`;
}

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    const start = end + 4;
    if (!Number.isFinite(length) || buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
});

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, { capabilities: { renameProvider: true, definitionProvider: true } });
    if (mode === "crash") setTimeout(() => process.exit(1), 10);
    return;
  }
  // A dead server answers nothing, however fast the request arrives — without
  // this the crash test races the exit and passes by luck.
  if (mode === "crash" && method !== "textDocument/didOpen") return;
  if (method === "initialized" || method === "exit") {
    if (method === "exit") process.exit(0);
    return;
  }
  if (method === "textDocument/didOpen") {
    // Remembered so `rename` can return ranges that match the real document —
    // a fake with hardcoded offsets tests the fake, not the client.
    documents.set(params.textDocument.uri, params.textDocument.text);
    if (mode === "nodiag" || mode === "silent") return;
    const uri = params.textDocument.uri;
    // `slowdiag` is what typescript-language-server really does: an EMPTY set the
    // moment the document opens, before the project is loaded, then the errors
    // once it is. A client that answers on the first push calls broken code
    // clean — reproduced here so the fix is testable without a real server or a
    // loaded CI runner to lose the race on.
    if (mode === "slowdiag") {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [] },
      });
    }
    // One error, one warning — enough to exercise severity filtering.
    const publish = () =>
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              severity: 1,
              code: 2304,
              message: "Cannot find name 'alpha'.",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
              severity: 2,
              message: "'beta' is declared but never read.",
            },
          ],
        },
      });
    if (mode === "slowdiag") setTimeout(publish, 40);
    else publish();
    return;
  }
  if (mode === "silent") return; // the whole point: never answers

  if (method === "textDocument/definition") {
    reply(id, [
      {
        uri: params.textDocument.uri,
        range: { start: { line: 4, character: 9 }, end: { line: 4, character: 14 } },
      },
    ]);
    return;
  }
  if (method === "textDocument/rename") {
    const uri =
      mode === "escape"
        ? `${new URL("../../../../../etc", params.textDocument.uri).toString()}/passwd`
        : params.textDocument.uri;
    const text = documents.get(params.textDocument.uri) ?? "";
    const word = wordAt(text, params.position);
    const edits = rangesOf(text, word).map((range) => ({ range, newText: params.newName }));
    reply(id, { changes: { [uri]: edits } });
    return;
  }
  if (method === "textDocument/completion") {
    reply(id, {
      items: [
        { label: "alpha", detail: "(method) alpha(): void" },
        { label: "beta", detail: "(property) beta: string" },
      ],
    });
    return;
  }
  if (method === "shutdown") {
    reply(id, null);
    return;
  }
  if (id !== undefined) reply(id, null);
}
