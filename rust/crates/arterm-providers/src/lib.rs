pub mod ollama;
pub mod openai_compat;

use anyhow::Result;
use async_trait::async_trait;

use arterm_core::{Message, StreamChunk, ToolSchema};

/// A chat completion provider: Ollama, OpenAI-compatible, etc.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// The display label (e.g. "ollama", "openai-compat").
    fn label(&self) -> &str;

    /// The model identifier.
    fn model(&self) -> &str;

    /// Stream a completion for the given conversation, yielding chunks as they
    /// arrive. Tool calls are parsed from the stream and yielded as
    /// `StreamChunk::ToolCall`. The `tools` slice advertises the tools the model
    /// is allowed to call; pass an empty slice to disable tool use.
    async fn stream(
        &self,
        messages: &[Message],
        system: Option<&str>,
        tools: &[ToolSchema],
    ) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>>;
}

/// Build a provider from the config. Currently supports:
/// - `ollama` (defaults to http://localhost:11434)
/// - `openai-compat` (requires `openaiCompatHost`)
pub fn build_provider(
    provider: &str,
    model: &str,
    host: Option<&str>,
    key: Option<&str>,
) -> Result<Box<dyn ChatProvider>> {
    match provider {
        "ollama" => Ok(Box::new(crate::ollama::OllamaProvider::new(model.to_string()))),
        "openai-compat" | "openai-compat" => {
            let host = host.ok_or_else(|| {
                anyhow::anyhow!("openai-compat provider requires 'openaiCompatHost' in config")
            })?;
            Ok(Box::new(crate::openai_compat::OpenAiCompatProvider::new(
                host.to_string(),
                model.to_string(),
                key.map(|k| k.to_string()),
            )))
        }
        _ => Err(anyhow::anyhow!("unknown provider: {provider}")),
    }
}
