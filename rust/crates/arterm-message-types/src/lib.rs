//! The conversation data contract.
//!
//! Every layer above depends on this crate, so it holds data and pure helpers
//! only — no filesystem, network, process, or UI access.
//!
//! The shape follows the Anthropic messages model, which is the one both
//! OpenAI-compatible and Ollama adapters can be projected onto without loss:
//!
//! - [`Role`] is **only** `User` / `Assistant`. There is no `System` role — the
//!   system prompt is a separate parameter on the provider call — and no `Tool`
//!   role: a tool's result is a [`ContentBlock::ToolResult`] carried inside a
//!   `User` message, paired to its [`ContentBlock::ToolUse`] by `tool_use_id`.
//!   A flat `{role, content: String}` message cannot express that pairing, which
//!   is why it is not the model used here.
//! - Reasoning has three distinct blocks with three different fates, see
//!   [`ContentBlock`].

use serde::{Deserialize, Serialize};

// ─── Roles and messages ──────────────────────────────────────────────────────

/// Who authored a message.
///
/// Deliberately two variants. See the module docs for why `System` and `Tool`
/// are absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    /// Wall-clock cost of the tool round this message carries results for.
    /// Display-only; never sent to a provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_duration_ms: Option<u64>,
}

/// Prompt-cache metadata. A breakpoint caches everything *before* it, so it is
/// attached to the last block of the prefix being frozen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheControl {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl: Option<String>,
}

impl CacheControl {
    pub fn ephemeral(ttl: Option<String>) -> Self {
        Self { kind: "ephemeral".to_string(), ttl }
    }
}

/// A unit of message content.
///
/// The three reasoning blocks are not redundant — they differ in what is
/// *replayed* to the provider on later turns:
///
/// - [`ContentBlock::ReasoningTrace`] is never replayed. It exists so the
///   transcript keeps what the model was thinking, at no token cost later.
/// - [`ContentBlock::Reasoning`] is replayed for backends that require their own
///   reasoning content back.
/// - [`ContentBlock::AnthropicThinking`] is replayed *with its signature*, which
///   Anthropic requires when thinking is used together with tools. Replaying it
///   unsigned fails the request rather than degrading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    /// Reasoning that IS replayed to the provider on later turns.
    Reasoning { text: String },
    /// Reasoning kept for the transcript only, never replayed. Carries no token
    /// cost on later turns and cannot trigger an "unsigned thinking" rejection.
    ReasoningTrace { text: String },
    /// Anthropic signed thinking. The signature must survive a round trip.
    AnthropicThinking { thinking: String, signature: String },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    /// A picture, base64-encoded, with its media type (`image/png`, …).
    Image { media_type: String, data: String },
}

impl Message {
    pub fn user(text: &str) -> Self {
        Self {
            role: Role::User,
            content: vec![ContentBlock::Text { text: text.to_string(), cache_control: None }],
            timestamp: Some(chrono::Utc::now()),
            tool_duration_ms: None,
        }
    }

    pub fn assistant_text(text: &str) -> Self {
        Self {
            role: Role::Assistant,
            content: vec![ContentBlock::Text { text: text.to_string(), cache_control: None }],
            timestamp: Some(chrono::Utc::now()),
            tool_duration_ms: None,
        }
    }

    /// A user message carrying images alongside the text. Images lead, because
    /// providers read the text as the question *about* what precedes it.
    pub fn user_with_images(text: &str, images: Vec<(String, String)>) -> Self {
        let mut content: Vec<ContentBlock> = images
            .into_iter()
            .map(|(media_type, data)| ContentBlock::Image { media_type, data })
            .collect();
        content.push(ContentBlock::Text { text: text.to_string(), cache_control: None });
        Self {
            role: Role::User,
            content,
            timestamp: Some(chrono::Utc::now()),
            tool_duration_ms: None,
        }
    }

    /// The user turn that answers a round of tool calls. One block per call, in
    /// the order the model asked for them — a provider that pairs `tool_use`
    /// with `tool_result` by position is given the wrong answer otherwise.
    pub fn tool_results(results: Vec<ContentBlock>) -> Self {
        Self {
            role: Role::User,
            content: results,
            timestamp: Some(chrono::Utc::now()),
            tool_duration_ms: None,
        }
    }

    /// Concatenated text of every [`ContentBlock::Text`] block. Reasoning and
    /// tool blocks are excluded: this is the message's *answer*, not its work.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// The tool calls this message requests, in order.
    pub fn tool_uses(&self) -> Vec<(&str, &str, &serde_json::Value)> {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.as_str(), name.as_str(), input))
                }
                _ => None,
            })
            .collect()
    }

    pub fn has_tool_uses(&self) -> bool {
        self.content.iter().any(|b| matches!(b, ContentBlock::ToolUse { .. }))
    }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

/// A tool as advertised to the provider.
///
/// This rides on **every** request of a turn, not once per turn: the loop
/// re-sends the whole prompt on each tool call, so the roster is billed again
/// each iteration. The token estimators exist so that cost stays measurable.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl ToolDefinition {
    fn payload(&self) -> String {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        })
        .to_string()
    }

    /// Serialized size of the full definition sent to providers.
    pub fn prompt_chars(&self) -> usize {
        self.payload().len()
    }

    /// Approximate prompt-token cost of the whole definition.
    pub fn prompt_token_estimate(&self) -> usize {
        estimate_tokens(&self.payload())
    }

    /// Approximate prompt-token cost of the description alone — the field that
    /// grows when a tool's docs are edited.
    pub fn description_token_estimate(&self) -> usize {
        estimate_tokens(&self.description)
    }

    pub fn aggregate_prompt_token_estimate(defs: &[ToolDefinition]) -> usize {
        defs.iter().map(Self::prompt_token_estimate).sum()
    }
}

/// The repo-wide token estimate: 4 characters per token. Approximate on
/// purpose — it is used for budgets and warnings, never for billing, which is
/// read back off the provider's own usage numbers.
pub fn estimate_tokens(s: &str) -> usize {
    const APPROX_CHARS_PER_TOKEN: usize = 4;
    s.len() / APPROX_CHARS_PER_TOKEN
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/// Token accounting for one request.
///
/// Cache reads and cache writes are reported separately and never folded into
/// `input_tokens`: a read costs ~10% of the input rate, so merging them
/// overstates an agent loop — which is mostly cache hits — by close to an order
/// of magnitude.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
}

/// Where a request is in its lifecycle, for the status line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPhase {
    Connecting,
    Waiting,
    Streaming,
    Retrying,
}

/// One event in a provider's response stream.
///
/// A tool call arrives in three parts — [`StreamEvent::ToolUseStart`], then a
/// run of [`StreamEvent::ToolInputDelta`] fragments that only parse as JSON once
/// concatenated, then [`StreamEvent::ToolUseEnd`] — because providers stream
/// argument JSON incrementally. Collapsing that into a single finished
/// `ToolCall` event is what forces a consumer to buffer the whole stream before
/// it can show anything.
///
/// All three carry the call's `id`. Without it the stream is ambiguous exactly
/// when it matters: an OpenAI-compatible endpoint asked for two tools at once
/// opens both before closing either, so a consumer pairing an unlabelled `End`
/// with the most recent `Start` hands one tool the other's arguments. Repairing
/// that downstream is impossible — the information is simply not on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamEvent {
    /// Assistant answer text.
    TextDelta(String),

    ToolUseStart { id: String, name: String },
    /// A fragment of one tool's input JSON. Only valid once concatenated.
    ToolInputDelta { id: String, delta: String },
    ToolUseEnd { id: String },

    /// Reasoning, which is displayed and metered but — unless it is signed
    /// thinking — never folded into the assistant's answer.
    ThinkingStart,
    ThinkingDelta(String),
    /// Signature for the thinking block currently open.
    ThinkingSignatureDelta(String),
    ThinkingEnd,

    /// The assistant message is complete.
    MessageEnd { stop_reason: Option<String> },

    /// A transient transport fault interrupted the stream and the provider is
    /// replaying the same request from the top. Consumers MUST discard every
    /// partial artifact of the current attempt (text, tool calls, reasoning) or
    /// the replayed stream renders duplicated. Safe because tools only execute
    /// after a stream completes, so a partial attempt has no side effects.
    RetryRollback { attempt: u32, max: u32 },

    TokenUsage(TokenUsage),

    ConnectionPhase { phase: ConnectionPhase },
    /// Provider-supplied transport detail for the status line.
    StatusDetail { detail: String },

    Error {
        message: String,
        /// Seconds until a rate limit resets, when the provider said so.
        retry_after_secs: Option<u64>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_reads_only_answer_blocks() {
        let msg = Message {
            role: Role::Assistant,
            content: vec![
                ContentBlock::ReasoningTrace { text: "working notes".into() },
                ContentBlock::Text { text: "the answer".into(), cache_control: None },
            ],
            timestamp: None,
            tool_duration_ms: None,
        };
        // Reasoning must not leak into the answer: it would be re-sent as part
        // of the history and re-billed for the rest of the session.
        assert_eq!(msg.text(), "the answer");
    }

    #[test]
    fn tool_results_ride_in_a_user_message() {
        let msg = Message::tool_results(vec![ContentBlock::ToolResult {
            tool_use_id: "call_1".into(),
            content: "ok".into(),
            is_error: None,
        }]);
        assert_eq!(msg.role, Role::User);
    }

    #[test]
    fn tool_uses_keep_the_order_the_model_asked_in() {
        let msg = Message {
            role: Role::Assistant,
            content: vec![
                ContentBlock::ToolUse { id: "a".into(), name: "read".into(), input: serde_json::json!({}) },
                ContentBlock::ToolUse { id: "b".into(), name: "grep".into(), input: serde_json::json!({}) },
            ],
            timestamp: None,
            tool_duration_ms: None,
        };
        let ids: Vec<&str> = msg.tool_uses().iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn content_blocks_round_trip_through_serde() {
        // The session journal replays these off disk, so a tagged shape that
        // survives a round trip is part of the contract, not an implementation
        // detail.
        let original = ContentBlock::ToolUse {
            id: "call_1".into(),
            name: "bash".into(),
            input: serde_json::json!({"command": "ls"}),
        };
        let encoded = serde_json::to_string(&original).expect("encode");
        let decoded: ContentBlock = serde_json::from_str(&encoded).expect("decode");
        match decoded {
            ContentBlock::ToolUse { id, name, .. } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "bash");
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn images_lead_the_text_that_asks_about_them() {
        let msg = Message::user_with_images("what is this", vec![("image/png".into(), "AAA".into())]);
        assert!(matches!(msg.content.first(), Some(ContentBlock::Image { .. })));
        assert_eq!(msg.text(), "what is this");
    }
}
