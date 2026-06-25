/**
 * Splits a byte stream into newline-delimited JSON objects. Used to parse
 * Ollama's streaming /api/chat and /api/pull responses.
 */
export async function* parseNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        // Skip a malformed line rather than killing the whole stream — proxies and
        // keep-alives occasionally inject non-JSON lines mid-response.
        if (line) {
          try {
            yield JSON.parse(line);
          } catch {
            // skip malformed line
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        // skip malformed trailing line
      }
    }
  } finally {
    reader.releaseLock();
  }
}
