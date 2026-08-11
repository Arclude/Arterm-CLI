use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;

use arterm_core::{
    Message, PermissionManager, PermissionVerdict, StreamChunk, ToolCall, ToolSchema,
};

/// Default maximum number of stream + tool-call iterations per turn.
/// Prevents infinite loops if the model keeps requesting tools without converging.
const MAX_ITERATIONS: usize = 25;

/// The agent loop: owns the conversation history, the provider, and the tools.
/// Runs turn by turn: each turn is one request → stream → (optional tool calls).
pub struct Agent {
    pub messages: Vec<Message>,
    pub provider: Arc<dyn arterm_providers::ChatProvider>,
    pub tools: arterm_tools::ToolRegistry,
    pub system: String,
    /// Permission system: controls which tools run automatically and which
    /// require user approval. Defaults to [`PermissionMode::Ask`].
    pub permissions: PermissionManager,
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
    /// A tool call needs user approval before it can run.
    ///
    /// Emitted when the permission mode requires asking. The TUI should prompt
    /// the user and respond via a permission-response channel (not yet wired).
    PermissionRequest {
        tool_call_id: String,
        tool_name: String,
        args: String,
        message: String,
    },
    /// The turn is complete.
    TurnEnd,
    /// An error occurred.
    Error(String),
}

impl Agent {
    /// Run one turn: send the conversation to the provider, stream the response,
    /// execute any tool calls, and feed results back. Emits events for the TUI.
    ///
    /// The loop continues (stream → tool calls → results → stream again) until the
    /// model responds with text only (no tool calls), or `MAX_ITERATIONS` is hit.
    pub async fn run_turn(&mut self, tx: &mpsc::UnboundedSender<AgentEvent>) -> Result<()> {
        // --- Build tool schemas from the registry ---
        let tool_schemas = self.build_tool_schemas();

        // --- Build the system prompt, embedding tool descriptions ---
        let system = self.build_system_prompt(&tool_schemas);

        for _iteration in 0..MAX_ITERATIONS {
            // --- Stream the completion ---
            // The provider trait accepts tool schemas so the model can advertise
            // and call tools via its native function-calling API.
            let mut rx = self
                .provider
                .stream(&self.messages, Some(&system), &tool_schemas)
                .await?;

            // --- Collect text deltas and tool calls from the stream ---
            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();

            while let Some(chunk) = rx.recv().await {
                match chunk {
                    StreamChunk::TextDelta(delta) => {
                        assistant_text.push_str(&delta);
                        let _ = tx.send(AgentEvent::TextDelta(delta));
                    }
                    StreamChunk::ToolCall(tc) => {
                        tool_calls.push(tc);
                    }
                    StreamChunk::Done => break,
                    StreamChunk::Error(e) => {
                        let _ = tx.send(AgentEvent::Error(e));
                        anyhow::bail!("stream error");
                    }
                }
            }

            // Record the assistant message (may be empty if only tool calls).
            self.messages.push(Message::assistant(&assistant_text));
            let _ = tx.send(AgentEvent::AssistantMessage(assistant_text));

            // --- If no tool calls, the model gave a final text answer ---
            if tool_calls.is_empty() {
                let _ = tx.send(AgentEvent::TurnEnd);
                return Ok(());
            }

            // --- Execute each tool call and record results ---
            for tc in &tool_calls {
                let _ = tx.send(AgentEvent::ToolCall {
                    name: tc.name.clone(),
                    args: tc.arguments.to_string(),
                });

                // --- Permission check ---
                // Ask the permission manager whether this tool may run.
                let (output, is_error) = match self.check_permission(&tc.name) {
                    PermissionVerdict::Allow => {
                        self.execute_tool(&tc.name, tc.arguments.clone()).await
                    }
                    PermissionVerdict::Deny => {
                        (format!("permission denied for tool '{}'", tc.name), true)
                    }
                    PermissionVerdict::Ask(prompt) => {
                        // Emit a permission request so the TUI can prompt the
                        // user. TODO: await an interactive response and branch
                        // on allow/deny once a response channel exists.
                        let _ = tx.send(AgentEvent::PermissionRequest {
                            tool_call_id: tc.id.clone(),
                            tool_name: tc.name.clone(),
                            args: tc.arguments.to_string(),
                            message: prompt,
                        });
                        (
                            format!(
                                "tool '{}' requires permission — interactive approval not yet implemented",
                                tc.name
                            ),
                            true,
                        )
                    }
                };

                let _ = tx.send(AgentEvent::ToolResult {
                    name: tc.name.clone(),
                    output: output.clone(),
                    is_error,
                });

                // Feed the tool result back into the conversation as a Tool message.
                self.messages.push(Message::Tool {
                    tool_use_id: tc.id.clone(),
                    content: output,
                });
            }

            // Loop back: tool results are now in the message history. The next
            // stream round lets the model read them and respond (or call more tools).
        }

        // --- Max iterations guard ---
        let msg = format!(
            "agent loop exceeded max iterations ({MAX_ITERATIONS}) — the model kept calling tools without converging"
        );
        let _ = tx.send(AgentEvent::Error(msg.clone()));
        anyhow::bail!(msg);
    }

    /// Build `ToolSchema` objects from the registry for the provider API.
    fn build_tool_schemas(&self) -> Vec<ToolSchema> {
        self.tools
            .schemas()
            .into_iter()
            .map(|s| {
                ToolSchema::new(
                    s.get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    s.get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    s.get("parameters")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}})),
                )
            })
            .collect()
    }

    /// Build the full system prompt for the coding agent.
    ///
    /// Composes several layers:
    /// 1. **Custom context (prepended)** — anything in `self.system` (e.g. a
    ///    custom `system_prompt` from config, or provider/model info) goes
    ///    first so user instructions take precedence.
    /// 2. **Base persona** — `arterm_config::default_system_prompt()`, the
    ///    built-in coding-agent identity with behavioural guidelines.
    /// 3. **Working directory** — the current directory for filesystem context.
    /// 4. **Tool catalogue** — each registered tool's name and description,
    ///    plus guidance on *how* to use tools effectively.
    fn build_system_prompt(&self, tools: &[ToolSchema]) -> String {
        // 1 — If a custom system prompt was provided (via config or caller),
        //     prepend it so user instructions take precedence.
        let mut prompt = String::new();
        if !self.system.trim().is_empty() {
            prompt.push_str(self.system.trim());
            prompt.push_str("\n\n");
        }

        // 2 — Built-in persona and behavioural guidelines (the base).
        prompt.push_str(&arterm_config::default_system_prompt());

        // 3 — Working directory so the model knows where it operates.
        let cwd = std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "(unknown)".to_string());
        prompt.push_str(&format!("\n\n## Working Directory\n\n{cwd}"));

        // 4 — Dynamic tool catalogue with usage guidance.
        if !tools.is_empty() {
            prompt.push_str("\n\n## Available Tools\n\n");
            prompt.push_str(
                "You have the following tools. The provider handles the tool-call \
                 wire format automatically — you only need to choose the right tool \
                 and supply the correct arguments.\n\n\
                 **How to work effectively:**\n\
                 - Explore before acting: read files and search before editing.\n\
                 - After making changes, run builds or tests to verify.\n\
                 - Prefer targeted edits over rewriting entire files.\n\
                 - Iterate in a closed loop until the task is truly complete.\n\n",
            );
            for t in tools {
                prompt.push_str(&format!("- **{}**: {}\n", t.name, t.description));
            }
            prompt.push_str(
                "\nWhen your work is complete, respond with text only — no further \
                 tool calls.",
            );
        }

        prompt
    }

    /// Check whether the named tool may run under the current permission
    /// settings. Unknown tools are allowed (they will fail in [`execute_tool`]).
    fn check_permission(&self, tool_name: &str) -> PermissionVerdict {
        match self.tools.get(tool_name) {
            Some(tool) => self.permissions.check(tool_name, tool.permission()),
            None => PermissionVerdict::Allow,
        }
    }

    /// Execute a single tool by name, returning `(output, is_error)`.
    async fn execute_tool(&self, name: &str, args: serde_json::Value) -> (String, bool) {
        match self.tools.get(name) {
            Some(tool) => match tool.execute(args).await {
                Ok(output) => (output, false),
                Err(e) => (e.to_string(), true),
            },
            None => (format!("unknown tool: {name}"), true),
        }
    }

    /// Push a user message.
    pub fn push_user(&mut self, content: impl Into<String>) {
        self.messages.push(Message::user(content));
    }
}
