//! `ask_user`: the agent asks the human a multiple-choice question and blocks
//! until they answer.
//!
//! Claude Code style: the question renders as a numbered option list the user
//! picks from (arrow keys or the number itself, then Enter), with an optional
//! free-text escape hatch. The selected answer comes back as the tool result,
//! so the model's next turn sees exactly what the user chose.
//!
//! The transport mirrors `StdinInputRequest`: the tool sends an
//! [`AskUserRequest`] down the context channel, the server forwards it to the
//! TUI as an `ask_user_request` wire event, and the TUI answers with an
//! `ask_user_response` that resolves a oneshot. When no client is attached
//! (headless `arterm run`, background sessions), the request fails fast with a
//! clear message instead of hanging forever -- the tool contract for those
//! callers is to plan without asking.

use super::{Tool, ToolContext, ToolOutput};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

/// How long to wait for a user answer before giving up. Generous by design:
/// the user may be reading the plan, and the turn is already blocked on them
/// anyway (the model is waiting on this tool result).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

pub struct AskUserTool;

impl AskUserTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AskUserTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    fn description(&self) -> &str {
        "Ask the user to pick from numbered options; the pick is the result."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["question", "options"],
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question to display above the options. One sentence, ending with a question mark."
                },
                "options": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 9,
                    "items": {
                        "type": "object",
                        "required": ["label"],
                        "properties": {
                            "label": {
                                "type": "string",
                                "description": "Short option label shown in the list"
                            },
                            "detail": {
                                "type": "string",
                                "description": "Optional longer explanation shown dimmed under the label"
                            }
                        }
                    },
                    "description": "2-9 numbered options the user picks from"
                },
                "allow_custom": {
                    "type": "boolean",
                    "description": "Whether the user may type free-form text instead of picking an option",
                    "default": true
                }
            }
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> anyhow::Result<ToolOutput> {
        let question = input
            .get("question")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or_else(|| anyhow::anyhow!("question is required and must be non-empty"))?;

        let raw_options = input
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("options array is required"))?;
        if raw_options.is_empty() || raw_options.len() > 9 {
            anyhow::bail!("options must contain between 1 and 9 entries");
        }

        let mut options = Vec::with_capacity(raw_options.len());
        for raw in raw_options.iter() {
            let label = raw
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .ok_or_else(|| anyhow::anyhow!("every option needs a non-empty label"))?;
            let detail = raw
                .get("detail")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(ToString::to_string);
            options.push(crate::tool::AskUserOption { label: label.to_string(), detail });
        }

        let allow_custom = input
            .get("allow_custom")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let Some(ask_tx) = ctx.ask_user_request_tx.as_ref() else {
            anyhow::bail!(
                "No interactive client is attached to this session, so the user \
                 cannot be asked. Proceed with your best-judgment choice and say \
                 so, or present the options as ordinary text and let the user \
                 reply in their next message."
            );
        };

        let request_id = format!("ask-{}", ctx.tool_call_id);
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        ask_tx
            .send(crate::tool::AskUserRequest {
                request_id: request_id.clone(),
                question: question.to_string(),
                options: options.clone(),
                allow_custom_hint: allow_custom
                    .then(|| "or type your own answer".to_string()),
                response_tx,
            })
            .map_err(|_| {
                anyhow::anyhow!(
                    "The interactive channel closed before the question reached the user"
                )
            })?;

        let response = match tokio::time::timeout(ANSWER_TIMEOUT, response_rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_send_err)) => {
                anyhow::bail!("The user interface dropped the question before answering");
            }
            Err(_elapsed) => {
                anyhow::bail!("The question timed out after 24h without an answer");
            }
        };

        let answer = response.answer_text(&options);
        let selected = response
            .selected_index
            .map(|i| i + 1)
            .and_then(|n| (n <= options.len()).then_some(n));

        Ok(ToolOutput::new(format!(
            "User answered: {}",
            if answer.is_empty() {
                "(no answer)".to_string()
            } else {
                match selected {
                    Some(n) => format!("[{}] {}", n, answer),
                    None => answer,
                }
            }
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_channel(
    ) -> (
        ToolContext,
        tokio::sync::mpsc::UnboundedReceiver<crate::tool::AskUserRequest>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut ctx = ToolContext::new(
            "s1".into(),
            "m1".into(),
            "t1".into(),
            None,
            arterm_tool_core::ToolExecutionMode::AgentTurn,
        );
        ctx.ask_user_request_tx = Some(tx);
        (ctx, rx)
    }

    #[tokio::test]
    async fn asks_and_returns_the_selected_option() {
        let (ctx, mut rx) = ctx_with_channel();
        let tool = AskUserTool;
        let handle = tokio::spawn(async move {
            tool.execute(
                json!({
                    "question": "Which approach?",
                    "options": [
                        {"label": "Option A"},
                        {"label": "Option B", "detail": "slower but safer"}
                    ],
                    "intent": "decide approach"
                }),
                ctx,
            )
            .await
            .expect("execute must succeed")
        });
        let req = rx.recv().await.expect("request must arrive");
        assert_eq!(req.question, "Which approach?");
        assert_eq!(req.options.len(), 2);
        assert_eq!(req.options[1].detail.as_deref(), Some("slower but safer"));
        assert!(req.allow_custom_hint.is_some());
        req.response_tx
            .send(crate::tool::AskUserResponse {
                selected_index: Some(1),
                custom: None,
            })
            .expect("response must be accepted");
        let out = handle.await.expect("task must join");
        assert_eq!(out.output, "User answered: [2] Option B");
    }

    #[tokio::test]
    async fn custom_text_overrides_the_selection() {
        let (ctx, mut rx) = ctx_with_channel();
        let handle = tokio::spawn(async move {
            AskUserTool
                .execute(
                    json!({
                        "question": "Pick one?",
                        "options": [{"label": "A"}, {"label": "B"}],
                        "intent": "decide"
                    }),
                    ctx,
                )
                .await
                .expect("execute must succeed")
        });
        let req = rx.recv().await.expect("request");
        req.response_tx
            .send(crate::tool::AskUserResponse {
                selected_index: None,
                custom: Some("do both in sequence".into()),
            })
            .expect("response");
        let out = handle.await.expect("join");
        assert_eq!(out.output, "User answered: do both in sequence");
    }

    #[tokio::test]
    async fn fails_fast_without_a_client_channel() {
        let ctx = ToolContext::new(
            "s1".into(),
            "m1".into(),
            "t1".into(),
            None,
            arterm_tool_core::ToolExecutionMode::Direct,
        );
        let err = AskUserTool
            .execute(
                json!({"question": "Q?", "options": [{"label": "A"}], "intent": "x"}),
                ctx,
            )
            .await
            .expect_err("must fail without a channel");
        assert!(err.to_string().contains("cannot be asked"));
    }

    #[tokio::test]
    async fn rejects_empty_options_and_missing_question() {
        let (ctx, _rx) = ctx_with_channel();
        let err = AskUserTool
            .execute(json!({"question": "Q?", "options": [], "intent": "x"}), ctx)
            .await
            .expect_err("empty options must fail");
        assert!(err.to_string().contains("between 1 and 9"));

        let (ctx2, _rx2) = ctx_with_channel();
        let err2 = AskUserTool
            .execute(json!({"options": [{"label": "A"}], "intent": "x"}), ctx2)
            .await
            .expect_err("missing question must fail");
        assert!(err2.to_string().contains("question"));
    }
}
