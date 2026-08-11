use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;

use arterm_core::{Message, StreamChunk};

/// The agent loop: owns the conversation history, the provider, and the tools.
/// Runs turn by turn: each turn is one request → stream → (optional tool calls).
pub struct Agent {
    pub messages: Vec<Message>,
    pub provider: Arc<dyn arterm_providers::ChatProvider>,
    pub tools: arterm_tools::ToolRegistry,
    pub system: String,
}

/// Events the agent emits during a turn, for the TUI to render.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A text delta from the model (partial assistant text).
    TextDelta(String),
    /// The model's full assistant message for this turn.
    AssistantMessage(String),
    /// A tool call was made by the model.
    ToolCall { name: String, args: String },
    /// A tool result.
    ToolResult { name: String, output: String, is_error: bool },
    /// The turn is complete.
    TurnEnd,
    /// An error occurred.
    Error(String),
}

impl Agent {
    /// Run one turn: send the conversation to the provider, stream the response,
    /// execute any tool calls, and feed results back. Emits events for the TUI.
    pub async fn run_turn(&mut self, tx: &mpsc::UnboundedSender<AgentEvent>) -> Result<()> {
        // Build the system prompt.
        let system = self.system.clone();

        // Stream the completion.
        let mut rx = self
            .provider
            .stream(&self.messages, Some(&system))
            .await?;

        // Collect the assistant text.
        let mut assistant_text = String::new();
        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::TextDelta(delta) => {
                    assistant_text.push_str(&delta);
                    let _ = tx.send(AgentEvent::TextDelta(delta));
                }
                StreamChunk::Done => break,
                StreamChunk::Error(e) => {
                    let _ = tx.send(AgentEvent::Error(e));
                    anyhow::bail!("stream error");
                }
                StreamChunk::ToolCall(_) => {
                    // Tool calls not yet supported in streaming (requires
                    // function-calling API). For now, text-only.
                }
            }
        }

        // Record the assistant message.
        self.messages.push(Message::assistant(&assistant_text));
        let _ = tx.send(AgentEvent::AssistantMessage(assistant_text));

        let _ = tx.send(AgentEvent::TurnEnd);
        Ok(())
    }

    /// Push a user message.
    pub fn push_user(&mut self, content: impl Into<String>) {
        self.messages.push(Message::user(content));
    }
}
