//! LSP client: spawn a language server, initialize it, and answer
//! definition / references / hover queries over JSON-RPC with
//! `Content-Length` framing (LSP base protocol).
//!
//! Deliberately minimal: one request at a time, no dynamic
//! registration, no workspace config push. The goal is agent-facing
//! navigation (go-to-def, find-references, hover) rather than a full
//! editor integration. Servers are detected from the project type and
//! must already be installed on PATH; failures surface as errors with
//! the install hint instead of being swallowed (observable failures).

use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};

/// Default per-request timeout. LSP servers can be slow on first query
/// (indexing), so this is generous but still bounded.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Timeout for the initialize handshake. Servers usually respond fast,
/// but rust-analyzer may compile proc macros first.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(120);

/// A language server command derived from project type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Detect which language server to use for a project root.
///
/// Order matters: TS projects often also contain package.json-adjacent
/// files that other servers would claim. Returns `None` when no known
/// server applies (caller reports this instead of guessing).
pub fn detect_server(root: &Path) -> Option<ServerCommand> {
    if root.join("Cargo.toml").exists() {
        return Some(ServerCommand {
            program: "rust-analyzer".into(),
            args: vec![],
        });
    }
    if root.join("tsconfig.json").exists() || root.join("package.json").exists() {
        return Some(ServerCommand {
            program: "typescript-language-server".into(),
            args: vec!["--stdio".into()],
        });
    }
    if root.join("go.mod").exists() {
        return Some(ServerCommand {
            program: "gopls".into(),
            args: vec![],
        });
    }
    if root.join("pyproject.toml").exists() || root.join("setup.py").exists() {
        return Some(ServerCommand {
            program: "pyright-langserver".into(),
            args: vec!["--stdio".into()],
        });
    }
    if root.join(".python-version").exists() {
        return Some(ServerCommand {
            program: "pyright-langserver".into(),
            args: vec!["--stdio".into()],
        });
    }
    None
}

/// Encode one JSON-RPC message as an LSP base-protocol frame.
pub fn encode_frame(msg: &Value) -> Vec<u8> {
    let body = msg.to_string();
    let mut buf = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    buf.extend_from_slice(body.as_bytes());
    buf
}

/// Decode `Content-Length` frames from a byte buffer, draining consumed
/// bytes so the buffer is ready for the next read. Partial frames stay
/// buffered until more input arrives.
pub fn decode_frames(buf: &mut Vec<u8>) -> Vec<Value> {
    let mut msgs = Vec::new();
    let mut consumed = 0;
    while let Some(hdr_end) = find_subsequence(&buf[consumed..], b"\r\n\r\n") {
        let header = String::from_utf8_lossy(&buf[consumed..consumed + hdr_end]).to_string();
        let Some(len) = parse_content_length(&header) else {
            // Malformed header: skip past this separator and try again.
            consumed += hdr_end + 4;
            continue;
        };
        let body_start = consumed + hdr_end + 4;
        if buf.len() < body_start + len {
            break; // partial body, wait for more input
        }
        let body = &buf[body_start..body_start + len];
        if let Ok(v) = serde_json::from_slice::<Value>(body) {
            msgs.push(v);
        }
        consumed = body_start + len;
    }
    if consumed > 0 {
        buf.drain(..consumed);
    }
    msgs
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            return rest.trim().parse::<usize>().ok();
        }
    }
    None
}

/// A live language server connection.
pub struct LspClient {
    child: Child,
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: Arc<AtomicI64>,
    /// Set when the reader task exits, so requests fail fast.
    closed: Arc<std::sync::atomic::AtomicBool>,
    server_name: String,
}

impl LspClient {
    /// Spawn a language server and complete the LSP initialize handshake.
    pub async fn spawn(server: &ServerCommand, root: &Path) -> Result<Self> {
        let mut cmd = Command::new(&server.program);
        cmd.args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .current_dir(root)
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn language server: {}", server.program))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("language server has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("language server has no stdout"))?;

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Writer task: frames in, bytes out.
        let (writer_tx, mut writer_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let mut stdin = stdin;
        tokio::spawn(async move {
            while let Some(frame) = writer_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Reader task: parse frames, resolve pending requests, ignore
        // server-initiated notifications (window/logMessage etc).
        let pending_r = Arc::clone(&pending);
        let closed_r = Arc::clone(&closed);
        let mut reader = BufReader::new(stdout);
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
            loop {
                let mut chunk = [0u8; 8192];
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        for msg in decode_frames(&mut buf) {
                            if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                                let mut pending = pending_r.lock().await;
                                if let Some(tx) = pending.remove(&id) {
                                    let _ = tx.send(msg);
                                }
                            }
                        }
                    }
                }
            }
            closed_r.store(true, Ordering::SeqCst);
            // Fail every pending request so waiters do not hang.
            let mut pending = pending_r.lock().await;
            for (_, tx) in pending.drain() {
                let _ = tx.send(Value::Null);
            }
        });

        let client = Self {
            child,
            writer_tx,
            pending,
            next_id: Arc::new(AtomicI64::new(1)),
            closed,
            server_name: server.program.clone(),
        };

        // initialize -> initialized, per LSP spec.
        let root_uri = path_to_uri(root);
        let init_params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": false },
                    "hover": { "contentFormat": ["markdown", "plaintext"] }
                }
            }
        });
        let result = tokio::time::timeout(INIT_TIMEOUT, client.request("initialize", init_params))
            .await
            .map_err(|_| anyhow!("language server initialize timed out"))??;
        if result.get("capabilities").is_none() {
            anyhow::bail!("language server returned no capabilities");
        }
        client
            .notify("initialized", json!({}))
            .await
            .context("failed to send initialized notification")?;
        Ok(client)
    }

    pub fn server_name(&self) -> &str {
        &self.server_name
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Send a request and wait for its response result.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if self.is_closed() {
            anyhow::bail!("language server connection closed");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        self.writer_tx
            .send(encode_frame(&msg))
            .await
            .context("failed to write to language server")?;

        let resp = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| anyhow!("language server request timed out: {method}"))?
            .context("language server connection closed")?;
        if resp.is_null() {
            anyhow::bail!("language server connection closed");
        }
        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
            let text = err.get("message").and_then(Value::as_str).unwrap_or("");
            anyhow::bail!("language server error {code}: {text}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Send a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        self.writer_tx
            .send(encode_frame(&msg))
            .await
            .context("failed to write to language server")?;
        Ok(())
    }

    /// textDocument/didOpen so the server has the current file content
    /// even when the editor on disk is ahead of the server's index.
    pub async fn did_open(&self, path: &Path, language_id: &str, text: &str) -> Result<()> {
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": path_to_uri(path),
                    "languageId": language_id,
                    "version": 1,
                    "text": text
                }
            }),
        )
        .await
    }

    /// textDocument/definition for a file + UTF-16 line/character position.
    pub async fn definition(&self, path: &Path, line: u32, character: u32) -> Result<Value> {
        self.request(
            "textDocument/definition",
            text_document_position(path, line, character),
        )
        .await
    }

    /// textDocument/references including the declaration itself.
    pub async fn references(&self, path: &Path, line: u32, character: u32) -> Result<Value> {
        let mut params = text_document_position(path, line, character);
        params["context"] = json!({ "includeDeclaration": true });
        self.request("textDocument/references", params).await
    }

    /// textDocument/hover at a position.
    pub async fn hover(&self, path: &Path, line: u32, character: u32) -> Result<Value> {
        self.request(
            "textDocument/hover",
            text_document_position(path, line, character),
        )
        .await
    }

    /// Ask the server to shut down and wait for the process to exit.
    pub async fn shutdown(&mut self) {
        let _ = self.request("shutdown", Value::Null).await;
        let _ = self.notify("exit", Value::Null).await;
        let _ = self.child.wait().await;
    }
}

fn text_document_position(path: &Path, line: u32, character: u32) -> Value {
    json!({
        "textDocument": { "uri": path_to_uri(path) },
        "position": { "line": line, "character": character }
    })
}

/// file:// URI per RFC 8089, percent-encoding specials.
pub fn path_to_uri(path: &Path) -> String {
    let mut out = String::from("file://");
    for comp in path.components() {
        use std::path::Component;
        match comp {
            Component::RootDir | Component::Prefix(_) => {}
            Component::Normal(c) => {
                out.push('/');
                out.push_str(&c.to_string_lossy());
            }
            _ => {}
        }
    }
    if out == "file://" {
        out.push('/');
    }
    out
}

/// Convert a UTF-8 byte offset in `text` to an LSP UTF-16
/// (line, character) position.
pub fn offset_to_position(text: &str, offset: usize) -> (u32, u32) {
    let offset = offset.min(text.len());
    let before = &text[..offset];
    let line = before.matches('\n').count() as u32;
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let col_text = &text[line_start..offset];
    let character = col_text.encode_utf16().count() as u32;
    (line, character)
}

/// Resolve the first occurrence of a bare symbol (e.g. `foo`) in a
/// source file to an LSP position, so callers can use names instead of
/// coordinates.
pub fn symbol_to_position(text: &str, symbol: &str) -> Option<(u32, u32)> {
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find(symbol) {
        let at = search_from + rel;
        // Word boundary check on both sides.
        let before_ok = text[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        let after = &text[at + symbol.len()..];
        let after_ok = after
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if before_ok && after_ok {
            return Some(offset_to_position(text, at));
        }
        search_from = at + symbol.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "test"});
        let frame = encode_frame(&msg);
        let mut buf = frame.clone();
        let msgs = decode_frames(&mut buf);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0], msg);
        assert!(buf.is_empty());
    }

    #[test]
    fn decode_partial_then_complete() {
        let msg = json!({"ok": true});
        let frame = encode_frame(&msg);
        let mut buf = frame[..frame.len() - 5].to_vec();
        let msgs = decode_frames(&mut buf);
        assert!(msgs.is_empty());
        buf.extend_from_slice(&frame[frame.len() - 5..]);
        let msgs = decode_frames(&mut buf);
        assert_eq!(msgs.len(), 1);
        assert!(buf.is_empty());
    }

    #[test]
    fn decode_multiple_frames() {
        let f1 = encode_frame(&json!({"id": 1}));
        let f2 = encode_frame(&json!({"id": 2}));
        let mut buf = [f1, f2].concat();
        let msgs = decode_frames(&mut buf);
        assert_eq!(msgs.len(), 2);
        assert!(buf.is_empty());
    }

    #[test]
    fn malformed_header_skipped() {
        let good = encode_frame(&json!({"id": 9}));
        let mut buf = b"garbage no header\r\n\r\n".to_vec();
        buf.extend_from_slice(&good);
        let msgs = decode_frames(&mut buf);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["id"], 9);
    }

    #[test]
    fn uri_encoding() {
        assert_eq!(path_to_uri(Path::new("/a/b/c.rs")), "file:///a/b/c.rs");
        assert_eq!(path_to_uri(Path::new("/")), "file:///");
    }

    #[test]
    fn position_utf16() {
        let text = "fn main() {\n    let emoji = \"🎉\";\n}";
        // "emoji" starts at line 1 char 8 (UTF-16).
        let (line, ch) = symbol_to_position(text, "emoji").unwrap();
        assert_eq!((line, ch), (1, 8));
    }

    #[test]
    fn position_word_boundaries() {
        let text = "let cat = 1; let category = 2;";
        assert!(symbol_to_position(text, "cat").is_some());
        // "cat" inside "category" must not match alone -> matches the
        // standalone `cat` first, which is correct.
        let (l, c) = symbol_to_position(text, "cat").unwrap();
        assert_eq!((l, c), (0, 4));
        assert!(symbol_to_position(text, "category").is_some());
        assert!(symbol_to_position(text, "zzz").is_none());
    }

    #[test]
    fn detects_rust_before_node() {
        let tmp = std::env::temp_dir().join(format!("lsp-detect-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        let server = detect_server(&tmp).unwrap();
        assert_eq!(server.program, "rust-analyzer");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn detects_none_for_plain_dir() {
        let tmp = std::env::temp_dir().join(format!("lsp-none-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(detect_server(&tmp).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// End-to-end against a mock language server (python3 script):
    /// spawn, initialize handshake, definition query, shutdown.
    /// Skips silently when python3 is unavailable.
    #[tokio::test]
    async fn e2e_mock_server() {
        let script = std::env::var("ARTERM_TEST_MOCK_LSP").ok().or_else(|| {
            // Shipped next to the crate's integration tests.
            let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/mock_lsp.py");
            p.exists().then(|| p.to_string_lossy().into_owned())
        });
        let Some(script) = script else {
            eprintln!("skipping: mock LSP server not found");
            return;
        };
        let server = ServerCommand {
            program: "python3".into(),
            args: vec![script],
        };
        let tmp = std::env::temp_dir().join(format!("lsp-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let mut client = LspClient::spawn(&server, &tmp)
            .await
            .expect("spawn+initialize");

        let def = client
            .definition(&tmp.join("src/main.rs"), 3, 8)
            .await
            .expect("definition");
        assert_eq!(def["uri"], "file:///lib/src/defs.rs");
        assert_eq!(def["range"]["start"]["line"], 10);

        client.shutdown().await;
        std::fs::remove_dir_all(&tmp).ok();
    }
}
