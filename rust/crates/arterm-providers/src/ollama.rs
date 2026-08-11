use anyhow::Result;
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;

use arterm_core::{Message, StreamChunk, ToolCall, ToolSchema};

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
        tools: &[ToolSchema],
    ) -> Result<tokio::sync::mpsc::Receiver<StreamChunk>> {
        let (tx, rx) = tokio::sync::mpsc::channel(64);

        let url = format!("{}/api/chat", self.host);
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages.iter().map(|m| {
                serde_json::json!({
                    "role": m.role(),
                    "content": m.content(),
                })
            }).collect::<Vec<_>>(),
            "stream": true,
        });

        // Advertise tools when any are provided. Ollama expects an array of
        // function definitions under "tools".
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(
                tools
                    .iter()
                    .map(|t| serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    }))
                    .collect(),
            );
        }

        let client = reqwest::Client::new();
        let resp = client.post(&url).json(&body).send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("Ollama error {status}: {text}");
        }

        let _model = self.model.clone();
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
                    #[derive(Deserialize, Default)]
                    struct ChatMsg {
                        #[serde(default)]
                        content: String,
                        #[serde(default)]
                        tool_calls: Vec<OllamaToolCall>,
                    }
                    #[derive(Deserialize)]
                    struct OllamaToolCall {
                        // Ollama does not send an id; synthesize one.
                        #[serde(default)]
                        function: Option<OllamaFunction>,
                    }
                    #[derive(Deserialize)]
                    struct OllamaFunction {
                        name: String,
                        #[serde(default)]
                        arguments: serde_json::Value,
                    }

                    if let Ok(resp) = serde_json::from_str::<ChatResponse>(&line) {
                        if let Some(msg) = resp.message {
                            if !msg.content.is_empty() {
                                let _ = tx.send(StreamChunk::TextDelta(msg.content)).await;
                            }
                            for tc in msg.tool_calls {
                                if let Some(func) = tc.function {
                                    let id = format!(
                                        "call_{}",
                                        uuid_v4_like()
                                    );
                                    let _ = tx
                                        .send(StreamChunk::ToolCall(ToolCall {
                                            id,
                                            name: func.name,
                                            arguments: func.arguments,
                                        }))
                                        .await;
                                }
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
        });

        Ok(rx)
    }
}

/// Generate a lightweight unique-ish id without pulling in the uuid crate.
fn uuid_v4_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
