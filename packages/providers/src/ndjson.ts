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
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield JSON.parse(tail);
  } finally {
    reader.releaseLock();
  }
}
