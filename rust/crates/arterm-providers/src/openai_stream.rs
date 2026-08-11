//! Translating an OpenAI-compatible chunk stream into [`StreamEvent`]s.
//!
//! Kept pure and separate from the HTTP client because this is where the
//! protocol is actually hard. A tool call does not arrive as an object; it
//! arrives as a *name* in one chunk and a run of argument fragments in the
//! chunks after it, keyed by `index`, and the fragments only parse as JSON once
//! concatenated. Code that waits for a single chunk carrying both a name and
//! complete arguments emits no tool calls at all against a standard endpoint —
//! which is exactly the bug this replaces.

use arterm_message_types::{StreamEvent, TokenUsage};
use serde::Deserialize;

/// Accumulates partial tool calls across chunks.
#[derive(Debug, Default)]
pub struct OpenAiStreamState {
    /// Open tool calls by their stream `index`. Not a `Vec`, because providers
    /// interleave indices freely and are not required to start at zero.
    open: Vec<OpenCall>,
    thinking_open: bool,
}

#[derive(Debug)]
struct OpenCall {
    index: u32,
    id: String,
    name: String,
    /// Argument JSON, concatenated. Invalid until the call closes.
    arguments: String,
    announced: bool,
}

#[derive(Debug, Deserialize, Default)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize, Default)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    /// DeepSeek's convention, copied by Zhipu/GLM, Moonshot and most
    /// OpenAI-compatible reasoning backends. Absent from the OpenAI spec, so it
    /// is read defensively — but NOT reading it is what makes a thinking model
    /// look like a hung request, since it streams no answer text while it
    /// reasons.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// The same field under the other name in circulation.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Deserialize, Default)]
struct ToolCallDelta {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Debug, Deserialize, Default)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Usage {
    #[serde(default)]
    prompt_tokens: Option<u64>,
    #[serde(default)]
    completion_tokens: Option<u64>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize, Default)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u64>,
}

impl OpenAiStreamState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Translate one chunk's JSON into the events it implies.
    ///
    /// Unparseable JSON yields nothing rather than an error: a proxy injecting
    /// a heartbeat object must not end a live turn.
    pub fn on_chunk(&mut self, json: &str) -> Vec<StreamEvent> {
        let Ok(chunk) = serde_json::from_str::<Chunk>(json) else {
            return Vec::new();
        };
        let mut events = Vec::new();

        for choice in chunk.choices {
            let delta = choice.delta;

            // Reasoning first: it precedes the answer, and a backend that only
            // reasons sends nothing else for as long as it thinks.
            let reasoning = delta.reasoning_content.or(delta.reasoning);
            if let Some(text) = reasoning.filter(|t| !t.is_empty()) {
                if !self.thinking_open {
                    self.thinking_open = true;
                    events.push(StreamEvent::ThinkingStart);
                }
                events.push(StreamEvent::ThinkingDelta(text));
            }

            if let Some(text) = delta.content.filter(|t| !t.is_empty()) {
                // Answer text closes the reasoning block: the model has stopped
                // thinking and started replying.
                if self.thinking_open {
                    self.thinking_open = false;
                    events.push(StreamEvent::ThinkingEnd);
                }
                events.push(StreamEvent::TextDelta(text));
            }

            for tc in delta.tool_calls {
                // Absent index means a single call; providers that send one
                // tool call sometimes omit it entirely.
                let index = tc.index.unwrap_or(0);
                let slot = match self.open.iter_mut().find(|c| c.index == index) {
                    Some(existing) => existing,
                    None => {
                        self.open.push(OpenCall {
                            index,
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                            announced: false,
                        });
                        self.open.last_mut().expect("just pushed")
                    }
                };

                if let Some(id) = tc.id.filter(|s| !s.is_empty()) {
                    slot.id = id;
                }
                if let Some(func) = tc.function {
                    if let Some(name) = func.name.filter(|s| !s.is_empty()) {
                        slot.name.push_str(&name);
                    }
                    if let Some(args) = func.arguments {
                        slot.arguments.push_str(&args);
                    }
                }

                // Announce as soon as the name is known, so the UI can show
                // "running grep…" while the arguments are still streaming.
                if !slot.announced && !slot.name.is_empty() {
                    slot.announced = true;
                    if slot.id.is_empty() {
                        slot.id = format!("call_{index}");
                    }
                    events.push(StreamEvent::ToolUseStart {
                        id: slot.id.clone(),
                        name: slot.name.clone(),
                    });
                }
                // The argument text is buffered rather than emitted per
                // fragment. A fragment is not independently meaningful — only
                // the concatenation parses — so forwarding each one would make
                // every consumer reimplement this accumulator.
            }

            if choice.finish_reason.is_some() {
                events.extend(self.close(choice.finish_reason));
            }
        }

        if let Some(usage) = chunk.usage {
            events.push(StreamEvent::TokenUsage(TokenUsage {
                input_tokens: usage.prompt_tokens,
                output_tokens: usage.completion_tokens,
                // Cache reads are reported separately and never folded into the
                // input count: a read costs a fraction of the input rate, so
                // merging them overstates an agent loop badly.
                cache_read_input_tokens: usage
                    .prompt_tokens_details
                    .and_then(|d| d.cached_tokens),
                cache_creation_input_tokens: None,
            }));
        }

        events
    }

    /// Finish the stream: close any open reasoning block and flush every tool
    /// call that was still accumulating.
    ///
    /// Called on `finish_reason` and again at `[DONE]`. A provider may send
    /// either, both, or — for the ones that just close the socket — neither, so
    /// the flush is idempotent and the caller always calls it.
    pub fn close(&mut self, stop_reason: Option<String>) -> Vec<StreamEvent> {
        let mut events = Vec::new();

        if self.thinking_open {
            self.thinking_open = false;
            events.push(StreamEvent::ThinkingEnd);
        }

        // Announce order, which is the order the provider first mentioned each
        // call. Every event carries its id, so ordering is presentation only —
        // it cannot mis-pair a call with another's arguments.
        for call in self.open.drain(..) {
            if !call.announced {
                continue;
            }
            events.push(StreamEvent::ToolInputDelta {
                id: call.id.clone(),
                delta: call.arguments,
            });
            events.push(StreamEvent::ToolUseEnd { id: call.id });
        }

        if let Some(reason) = stop_reason {
            events.push(StreamEvent::MessageEnd { stop_reason: Some(reason) });
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(chunks: &[&str]) -> Vec<StreamEvent> {
        let mut state = OpenAiStreamState::new();
        let mut events: Vec<StreamEvent> = Vec::new();
        for c in chunks {
            events.extend(state.on_chunk(c));
        }
        events.extend(state.close(None));
        events
    }

    fn tool_calls(events: &[StreamEvent]) -> Vec<(String, String, String)> {
        // Models a real consumer: track every open call by id, so two calls
        // streaming at once cannot be confused for one another.
        let mut names: Vec<(String, String)> = Vec::new();
        let mut args: Vec<(String, String)> = Vec::new();
        let mut out = Vec::new();
        for e in events {
            match e {
                StreamEvent::ToolUseStart { id, name } => names.push((id.clone(), name.clone())),
                StreamEvent::ToolInputDelta { id, delta } => {
                    match args.iter_mut().find(|(k, _)| k == id) {
                        Some((_, buf)) => buf.push_str(delta),
                        None => args.push((id.clone(), delta.clone())),
                    }
                }
                StreamEvent::ToolUseEnd { id } => {
                    let name = names
                        .iter()
                        .find(|(k, _)| k == id)
                        .map(|(_, n)| n.clone())
                        .unwrap_or_default();
                    let input = args
                        .iter()
                        .find(|(k, _)| k == id)
                        .map(|(_, a)| a.clone())
                        .unwrap_or_default();
                    out.push((id.clone(), name, input));
                }
                _ => {}
            }
        }
        out
    }

    #[test]
    fn a_tool_call_split_across_chunks_is_assembled() {
        // The real wire shape, and the one the previous implementation could
        // not read: the name arrives with EMPTY arguments, and the arguments
        // arrive later with no name. Requiring both in one chunk yields no
        // tool call at all.
        let events = drive(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"a.rs\"}"}}]}}]}"#,
        ]);
        let calls = tool_calls(&events);
        assert_eq!(calls.len(), 1, "expected exactly one assembled call");
        assert_eq!(calls[0].0, "call_abc");
        assert_eq!(calls[0].1, "read");
        assert_eq!(calls[0].2, r#"{"path":"a.rs"}"#);
        // And the arguments must actually be valid JSON once joined.
        serde_json::from_str::<serde_json::Value>(&calls[0].2).expect("valid JSON");
    }

    #[test]
    fn the_call_is_announced_before_its_arguments_finish() {
        // So the UI can say what is running instead of showing a spinner until
        // the last argument byte lands.
        let mut state = OpenAiStreamState::new();
        let first = state.on_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":""}}]}}]}"#,
        );
        assert!(matches!(first.as_slice(), [StreamEvent::ToolUseStart { .. }]));
    }

    #[test]
    fn parallel_calls_never_cross_their_arguments() {
        // Two calls streaming at once, announced out of index order. What must
        // hold is that each call keeps ITS OWN arguments: `ToolUseEnd` has no
        // id, so a consumer pairs it with the last `ToolUseStart`, and any
        // reordering between the two silently feeds one tool another's input.
        let events = drive(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"grep","arguments":"{\"q\":\"x\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\"path\":\"a.rs\"}"}}]}}]}"#,
        ]);
        let calls = tool_calls(&events);
        assert_eq!(calls.len(), 2);
        for (id, name, args) in &calls {
            match name.as_str() {
                "grep" => {
                    assert_eq!(id, "b");
                    assert_eq!(args, r#"{"q":"x"}"#);
                }
                "read" => {
                    assert_eq!(id, "a");
                    assert_eq!(args, r#"{"path":"a.rs"}"#);
                }
                other => panic!("unexpected call {other}"),
            }
        }
    }

    #[test]
    fn reasoning_is_reported_under_either_field_name() {
        for field in ["reasoning_content", "reasoning"] {
            let events =
                drive(&[&format!(r#"{{"choices":[{{"delta":{{"{field}":"thinking..."}}}}]}}"#)]);
            assert!(
                events.iter().any(|e| matches!(e, StreamEvent::ThinkingDelta(t) if t == "thinking...")),
                "{field} must be read"
            );
            assert!(events.iter().any(|e| matches!(e, StreamEvent::ThinkingStart)));
        }
    }

    #[test]
    fn answer_text_closes_the_reasoning_block() {
        let events = drive(&[
            r#"{"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#,
            r#"{"choices":[{"delta":{"content":"the answer"}}]}"#,
        ]);
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match e {
                StreamEvent::ThinkingStart => "start",
                StreamEvent::ThinkingDelta(_) => "delta",
                StreamEvent::ThinkingEnd => "end",
                StreamEvent::TextDelta(_) => "text",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["start", "delta", "end", "text"]);
    }

    #[test]
    fn cached_prompt_tokens_are_reported_apart_from_fresh_ones() {
        let events =
            drive(&[r#"{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":900}}}"#]);
        let usage = events
            .iter()
            .find_map(|e| match e {
                StreamEvent::TokenUsage(u) => Some(*u),
                _ => None,
            })
            .expect("usage reported");
        assert_eq!(usage.input_tokens, Some(1000));
        assert_eq!(usage.cache_read_input_tokens, Some(900));
    }

    #[test]
    fn a_heartbeat_object_does_not_end_the_turn() {
        let mut state = OpenAiStreamState::new();
        assert!(state.on_chunk("{not json").is_empty());
        assert!(state.on_chunk(r#"{"unexpected":true}"#).is_empty());
    }

    #[test]
    fn a_stream_that_just_stops_still_flushes_its_calls() {
        // Some endpoints close the socket with no finish_reason and no [DONE].
        // Without the flush the call is silently lost and the turn hangs
        // waiting for a result that was never requested.
        let mut state = OpenAiStreamState::new();
        state.on_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read","arguments":"{}"}}]}}]}"#,
        );
        let flushed = state.close(None);
        assert!(flushed.iter().any(|e| matches!(e, StreamEvent::ToolUseEnd { .. })));
    }
}
