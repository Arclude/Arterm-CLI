use anyhow::Result;
use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use arterm_core::{Message, StreamChunk};

use super::ChatProvider;

/// Ollama provider: streams from http://localhost:11434/api/chat
pub struct OllamaProvider {
    model: String,
    host: String,
}

impl OllamaProvider {
    pub fn new(model: String) -> Self {
        Self {
            model,
            host: std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into()),
        }
    }
}

#[async_trait]
impl ChatProvider for OllamaProvider {
    fn label(&self) -> &str { "ollama" }
    fn model(&self) -> &str { &self.model }

    async fn stream(
        &self,
        messages: &[Message],
        _system: Option<&str>,
    ) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>> {
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        let url = format!("{}/api/chat", self.host);
        let body = serde_json::json!({
            "model": self.model,
            "messages": messages.iter().map(|m| {
                serde_json::json!({
                    "role": m.role(),
                    "content": m.content(),
                })
            }).collect::<Vec<_>>(),
            "stream": true,
        });

        let client = reqwest::Client::new();
        let resp = client.post(&url).json(&body).send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Ollama error {status}: {text}");
        }

        let model = self.model.clone();
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

                // Ollama streams newline-delimited JSON objects.
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    buf = buf[pos + 1..].to_string();
                    if line.is_empty() { continue; }

                    #[derive(Deserialize)]
                    struct ChatResponse {
                        #[serde(default)]
                        message: Option<ChatMsg>,
                        #[serde(default)]
                        done: bool,
                    }
                    #[derive(Deserialize)]
                    struct ChatMsg {
                        #[serde(default)]
                        content: String,
                    }

                    if let Ok(resp) = serde_json::from_str::<ChatResponse>(&line) {
                        if let Some(msg) = resp.message {
                            if !msg.content.is_empty() {
                                let _ = tx.send(StreamChunk::TextDelta(msg.content)).await;
                            }
                        }
                        if resp.done {
                            let _ = tx.send(StreamChunk::Done).await;
                            return;
                        }
                    }
                }
            }

            // Stream ended without explicit done
            let _ = tx.send(StreamChunk::Done).await;
            let _ = model; // suppress unused warning if we remove model later
        });

        Ok(rx)
    }
}
