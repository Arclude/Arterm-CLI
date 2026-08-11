use serde::{Deserialize, Serialize};

pub mod permission;
pub use permission::{PermissionManager, PermissionMode, PermissionVerdict};

/// A single message in the conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    System { content: String },
    User { content: String },
    Assistant { content: String },
    Tool { tool_use_id: String, content: String },
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self::User { content: content.into() }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::Assistant { content: content.into() }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::System { content: content.into() }
    }

    pub fn role(&self) -> &'static str {
        match self {
            Self::System { .. } => "system",
            Self::User { .. } => "user",
            Self::Assistant { .. } => "assistant",
            Self::Tool { .. } => "tool",
        }
    }

    pub fn content(&self) -> &str {
        match self {
            Self::System { content }
            | Self::User { content }
            | Self::Assistant { content }
            | Self::Tool { content, .. } => content,
        }
    }
}

/// A chunk streamed from the provider during generation.
#[derive(Debug, Clone)]
pub enum StreamChunk {
    /// A text delta (partial assistant text).
    TextDelta(String),
    /// The model wants to call a tool.
    ToolCall(ToolCall),
    /// The stream is done.
    Done,
    /// An error occurred mid-stream.
    Error(String),
}

/// A tool call requested by the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Schema describing a tool/function the model may call.
///
/// Serialized into the provider's `tools` (OpenAI) or `tools` (Ollama) request
/// field. `parameters` is a JSON Schema object describing the arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    /// The function name the model uses to invoke the tool.
    pub name: String,
    /// Human-readable description of what the tool does.
    pub description: String,
    /// JSON Schema describing the parameters object.
    pub parameters: serde_json::Value,
}

impl ToolSchema {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// A tool's result, fed back into the conversation.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub output: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(tool_use_id: impl Into<String>, output: impl Into<String>) -> Self {
        Self { tool_use_id: tool_use_id.into(), output: output.into(), is_error: false }
    }

    pub fn err(tool_use_id: impl Into<String>, output: impl Into<String>) -> Self {
        Self { tool_use_id: tool_use_id.into(), output: output.into(), is_error: true }
    }
}

/// The permission level a tool requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// Read-only tools (read, glob, grep).
    Read,
    /// Tools that modify state (write, edit, bash).
    Write,
}
