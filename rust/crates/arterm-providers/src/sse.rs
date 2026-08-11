//! Server-sent-event framing.
//!
//! Split out and made pure so the stream can be tested without a network: the
//! bugs here are all about how bytes arrive — a JSON object cut in half across
//! two TCP reads, a `data:` with no space after the colon, a `[DONE]` arriving
//! in the same read as the last payload — and none of those reproduce reliably
//! against a live endpoint.

/// Accumulates bytes and yields complete `data:` payloads.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buf: String,
}

/// One decoded frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseFrame {
    /// The payload of a `data:` line, verbatim.
    Data(String),
    /// The `[DONE]` sentinel. Distinguished from data because it is a control
    /// signal, not a message — parsing it as JSON is how a stream ends with a
    /// spurious error.
    Done,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of bytes; get back every frame that is now complete.
    ///
    /// A partial line is retained, not dropped: chunk boundaries fall in the
    /// middle of a JSON object routinely, and a decoder that discarded the
    /// remainder would lose a token every few hundred bytes.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseFrame> {
        self.buf.push_str(&String::from_utf8_lossy(bytes));
        let mut frames = Vec::new();

        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf[..pos].trim_end_matches('\r').trim().to_string();
            self.buf.drain(..=pos);

            if line.is_empty() || line.starts_with(':') {
                // Blank lines separate events; a leading colon is a comment,
                // which some proxies send as a keep-alive.
                continue;
            }
            let Some(payload) = line.strip_prefix("data:") else {
                // `event:`/`id:`/`retry:` carry nothing we act on.
                continue;
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                frames.push(SseFrame::Done);
            } else if !payload.is_empty() {
                frames.push(SseFrame::Data(payload.to_string()));
            }
        }

        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(s: &str) -> SseFrame {
        SseFrame::Data(s.to_string())
    }

    #[test]
    fn a_json_object_split_across_reads_is_reassembled() {
        // The failure this exists to prevent: half an object arrives, and a
        // decoder without a buffer drops it and loses the token inside.
        let mut dec = SseDecoder::new();
        assert!(dec.push(b"data: {\"a\":").is_empty());
        assert_eq!(dec.push(b"1}\n"), vec![data("{\"a\":1}")]);
    }

    #[test]
    fn several_frames_in_one_read_all_come_out() {
        let mut dec = SseDecoder::new();
        let frames = dec.push(b"data: {\"a\":1}\n\ndata: {\"a\":2}\n\ndata: [DONE]\n\n");
        assert_eq!(frames, vec![data("{\"a\":1}"), data("{\"a\":2}"), SseFrame::Done]);
    }

    #[test]
    fn the_space_after_the_colon_is_optional() {
        // Not every server writes `data: `; the spec makes the space optional
        // and a prefix match on "data: " silently ignores those streams.
        let mut dec = SseDecoder::new();
        assert_eq!(dec.push(b"data:{\"a\":1}\n"), vec![data("{\"a\":1}")]);
    }

    #[test]
    fn keep_alive_comments_and_crlf_are_ignored() {
        let mut dec = SseDecoder::new();
        assert!(dec.push(b": keep-alive\r\n\r\n").is_empty());
        assert_eq!(dec.push(b"data: {\"a\":1}\r\n"), vec![data("{\"a\":1}")]);
    }

    #[test]
    fn done_is_a_control_signal_not_a_payload() {
        let mut dec = SseDecoder::new();
        assert_eq!(dec.push(b"data: [DONE]\n"), vec![SseFrame::Done]);
    }
}
