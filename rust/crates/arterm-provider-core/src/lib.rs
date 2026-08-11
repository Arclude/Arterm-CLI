//! The provider contract.
//!
//! Every backend — Anthropic, an OpenAI-compatible endpoint, Ollama — is an
//! implementation of [`Provider`]. The trait lives apart from the adapters so
//! the agent loop can depend on "a provider" without depending on any HTTP
//! stack, and so adding a backend never recompiles the loop.

pub mod error;
pub mod retry;

pub use error::{ProviderError, ProviderErrorKind, is_transient_transport_error};
pub use retry::{RetryPolicy, parse_retry_after};

use anyhow::Result;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use arterm_message_types::{Message, StreamEvent, ToolDefinition};

/// A provider's response, as it arrives.
pub type EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>;

/// An LLM backend.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Start a request and hand back its stream.
    ///
    /// Returning the stream rather than the finished text is the whole point:
    /// the first token must be able to reach the screen before the last one
    /// exists.
    async fn complete(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        system: &str,
    ) -> Result<EventStream>;

    /// The same request with the system prompt split into a part that never
    /// changes and a part that does (the time, the cwd, the git state).
    ///
    /// This exists for prompt caching. A cache breakpoint covers everything
    /// before it, so a volatile string anywhere in the prefix invalidates the
    /// whole prefix on every request — and the loop re-sends that prefix on
    /// every tool call, not once per turn. The default implementation moves the
    /// dynamic half out of the system prompt and into the conversation, where
    /// it lands after the cached prefix instead of inside it.
    async fn complete_split(
        &self,
        messages: &[Message],
        tools: &[ToolDefinition],
        system_static: &str,
        system_dynamic: &str,
    ) -> Result<EventStream> {
        let with_context = messages_with_dynamic_context(messages, system_dynamic);
        self.complete(&with_context, tools, system_static).await
    }

    /// The stable, machine-facing id (`"anthropic"`, `"openai-compat"`,
    /// `"ollama"`). Routing and billing key off this, so it must not change to
    /// reflect a runtime selection — use [`Provider::display_name`] for that.
    fn name(&self) -> &str;

    /// What to show the user for the *current* selection. Defaults to
    /// [`Provider::name`]; an adapter serving several profiles behind one id
    /// overrides it so the UI names the endpoint actually in use.
    fn display_name(&self) -> String {
        self.name().to_string()
    }

    fn model(&self) -> String;

    /// Whether the model exposes a native function-calling API.
    ///
    /// `false` means the loop must parse tool calls out of the text body
    /// instead, which is lossier — so this is a capability question, not a
    /// preference.
    fn supports_native_tools(&self) -> bool {
        true
    }

    /// Tokens this model can be sent, when the provider knows.
    ///
    /// `None` means unknown, and unknown must stay distinguishable from a
    /// default: a wrong small number makes the agent compact a 1M-token model
    /// every few thousand tokens, and a wrong large one gets the request
    /// rejected mid-run.
    fn context_limit(&self) -> Option<u64> {
        None
    }
}

/// Append volatile context as a trailing user turn rather than folding it into
/// the system prompt.
///
/// Placed after the last user message, so everything before it — the roster,
/// the system prompt, the history — stays byte-identical between requests and
/// keeps its cache.
pub fn messages_with_dynamic_context(messages: &[Message], dynamic: &str) -> Vec<Message> {
    let mut out = messages.to_vec();
    if dynamic.trim().is_empty() {
        return out;
    }
    out.push(Message::user(&format!("<system-reminder>\n{dynamic}\n</system-reminder>")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use arterm_message_types::Role;

    #[test]
    fn dynamic_context_lands_after_the_history_it_must_not_invalidate() {
        let messages =
            vec![Message::user("first"), Message::assistant_text("answer"), Message::user("latest")];
        let out = messages_with_dynamic_context(&messages, "Time: 10:00:00 UTC");

        assert_eq!(out.len(), 4);
        // The cached prefix is untouched, byte for byte.
        assert_eq!(out[0].text(), "first");
        assert_eq!(out[1].text(), "answer");
        assert_eq!(out[2].text(), "latest");
        assert_eq!(out[3].role, Role::User);
        assert!(out[3].text().starts_with("<system-reminder>"));
    }

    #[test]
    fn empty_dynamic_context_adds_no_turn() {
        // An empty reminder would still be a message: it would change the
        // request shape and buy nothing.
        let messages = vec![Message::user("only")];
        assert_eq!(messages_with_dynamic_context(&messages, "   ").len(), 1);
    }
}
