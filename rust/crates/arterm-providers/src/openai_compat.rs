use anyhow::Result;
use async_trait::async_trait;
use futures::StreamExt;

use arterm_core::{Message, StreamChunk};

use super::ChatProvider;

/// OpenAI-compatible provider: streams via SSE from `{host}/chat/completions`.
/// Works with any OpenAI-compatible API (Z.AI, Together, Anyscale, etc.)
pub struct OpenAiCompatProvider {
    host: String,
    model: String,
    key: Option<String>,
}

impl OpenAiCompatProvider {
    pub fn new(host: String, model: String, key: Option<String>) -> Self {
        Self { host, model, key }
    }
}

#[async_trait]
impl ChatProvider for OpenAiCompatProvider {
    fn label(&self) -> &str { "openai-compat" }
    fn model(&self) -> &str { &self.model }

    async fn stream(
        &self,
        messages: &[Message],
        system: Option<&str>,
    ) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>> {
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        let url = format!("{}/chat/completions", self.host.trim_end_matches('/'));
        let mut msgs: Vec<serde_json::Value> = Vec::new();
        if let Some(sys) = system {
            msgs.push(serde_json::json!({"role": "system", "content": sys}));
        }
        for m in messages {
            msgs.push(serde_json::json!({"role": m.role(), "content": m.content()}));
        }

        let body = serde_json::json!({
            "model": self.model,
            "messages": msgs,
            "stream": true,
        });

        let mut req = reqwest::Client::new()
            .post(&url)
            .json(&body)
            .header("Content-Type", "application/json");
        if let Some(ref key) = self.key {
            req = req.bearer_auth(key);
        }
        let resp = req.send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("OpenAI-compat error {status}: {text}");
        }

        tokio::spawn(async move {
            let mut stream = resp.bytes_stream();
            let mut buf = String::new();

            while let Some(chunk_result) = stream.next().await {
                let chunk = match chunk_result {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = tx.send(StreamChunk::Error(e.to_string())).await;
                        return;
                    }
                };
                buf.push_str(&String::from_utf8_lossy(&chunk));

                // SSE: lines starting with "data: "
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    buf = buf[pos + 1..].to_string();
                    if line.is_empty() { continue; }

                    let data = match line.strip_prefix("data: ") {
                        Some(d) => d.trim(),
                        None => continue,
                    };
                    if data == "[DONE]" {
                        let _ = tx.send(StreamChunk::Done).await;
                        return;
                    }

                    #[derive(serde::Deserialize, Default)]
                    struct SseChunk {
                        #[serde(default)]
                        choices: Vec<SseChoice>,
                    }
                    #[derive(serde::Deserialize, Default)]
                    struct SseChoice {
                        #[serde(default)]
                        delta: SseDelta,
                    }
                    #[derive(serde::Deserialize, Default)]
                    struct SseDelta {
                        #[serde(default)]
                        content: String,
                    }

                    if let Ok(chunk) = serde_json::from_str::<SseChunk>(data) {
                        for choice in chunk.choices {
                            if !choice.delta.content.is_empty() {
                                let _ = tx.send(StreamChunk::TextDelta(choice.delta.content)).await;
                            }
                        }
                    }
                }
            }

            let _ = tx.send(StreamChunk::Done).await;
        });

        Ok(rx)
    }
}
