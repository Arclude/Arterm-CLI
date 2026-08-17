//! LSP navigation tool: go-to-definition, find-references, hover.
//!
//! Wraps `arterm_base::lsp::LspClient`: detects the language server for
//! the project, spawns it, runs a single query, and formats the answer
//! as `file:line:col` locations the model can feed straight back into
//! reads. Servers must be installed on PATH (rust-analyzer,
//! typescript-language-server, gopls, pyright-langserver); the tool
//! reports the install hint when they are missing.

use anyhow::Result;
use arterm_base::lsp::{LspClient, detect_server, symbol_to_position};
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::{Tool, ToolContext, ToolOutput};

pub struct LspTool;

impl LspTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Debug, serde::Deserialize)]
struct LspInput {
    /// Action: definition | references | hover
    action: String,
    /// Absolute or workspace-relative file containing the symbol.
    file: String,
    /// Symbol name to resolve to a position (mutually exclusive with line/character).
    #[serde(default)]
    symbol: Option<String>,
    /// 0-based line (use symbol instead when convenient).
    #[serde(default)]
    line: Option<u32>,
    /// 0-based UTF-16 character offset in the line.
    #[serde(default)]
    character: Option<u32>,
}

impl Default for LspTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        "lsp"
    }

    fn description(&self) -> &str {
        "Language-server navigation: go-to-definition, find-references, hover for a symbol. \
         Auto-detects the language server from the project (rust-analyzer, \
         typescript-language-server, gopls, pyright-langserver must be on PATH). \
         Returns file:line:col locations. First query may be slow while the server indexes."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["definition", "references", "hover"],
                    "description": "definition: where is this symbol declared. references: everywhere it is used. hover: type/signature info."
                },
                "file": {
                    "type": "string",
                    "description": "File containing the symbol (workspace-relative or absolute)."
                },
                "symbol": {
                    "type": "string",
                    "description": "Symbol name; resolved to its first occurrence in the file. Either this or line+character is required."
                },
                "line": { "type": "integer", "description": "0-based line (alternative to symbol)." },
                "character": { "type": "integer", "description": "0-based UTF-16 column (required with line)." },
                "intent": {
                    "type": "string",
                    "description": "Required short label shown in the UI: why this call is being made."
                }
            },
            "required": ["action", "file", "intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input: LspInput =
            serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid lsp input: {e}"))?;
        let action = input.action.as_str();

        let file = PathBuf::from(&input.file);
        let file = if file.is_absolute() {
            file
        } else {
            ctx.working_dir
                .as_ref()
                .map(|d| d.join(&file))
                .unwrap_or(file)
        };
        let file = file
            .canonicalize()
            .map_err(|e| anyhow::anyhow!("lsp: cannot resolve file {}: {e}", input.file))?;

        let text = tokio::fs::read_to_string(&file)
            .await
            .map_err(|e| anyhow::anyhow!("lsp: cannot read {}: {e}", file.display()))?;

        let (line, character) = match (&input.symbol, input.line, input.character) {
            (Some(sym), _, _) => symbol_to_position(&text, sym).ok_or_else(|| {
                anyhow::anyhow!("lsp: symbol `{sym}` not found in {}", file.display())
            })?,
            (None, Some(l), Some(c)) => (l, c),
            (None, _, _) => {
                anyhow::bail!("lsp: provide either `symbol` or both `line` and `character`")
            }
        };

        let root = project_root(&file);
        let Some(server) = server_for(&root) else {
            return Ok(ToolOutput::new(format!(
                "lsp: no supported project root found above {} (supported: Cargo.toml -> rust-analyzer, \
                 tsconfig.json/package.json -> typescript-language-server, go.mod -> gopls, \
                 pyproject.toml -> pyright-langserver)",
                root.display()
            )));
        };

        let mut client = LspClient::spawn(&server, &root).await.map_err(|e| {
            anyhow::anyhow!(
                "lsp: failed to start {} (is it installed and on PATH?): {e}",
                server.program
            )
        })?;

        let language_id = language_id_for(&file);
        let _ = client.did_open(&file, language_id, &text).await;

        let result = match action {
            "definition" => client.definition(&file, line, character).await,
            "references" => client.references(&file, line, character).await,
            "hover" => client.hover(&file, line, character).await,
            other => Err(anyhow::anyhow!(
                "lsp: unknown action `{other}` (definition|references|hover)"
            )),
        };
        client.shutdown().await;
        let result = result?;

        let out = match action {
            "hover" => format_hover(&result),
            _ => format_locations(&result),
        };
        Ok(ToolOutput::new(out))
    }
}

/// When `ARTERM_TEST_MOCK_LSP` points at a script, use it as the
/// server for every project (test hook).
fn server_for(root: &Path) -> Option<arterm_base::lsp::ServerCommand> {
    if let Ok(script) = std::env::var("ARTERM_TEST_MOCK_LSP") {
        return Some(arterm_base::lsp::ServerCommand {
            program: "python3".into(),
            args: vec![script],
        });
    }
    detect_server(root)
}

/// Walk up from `file` to the nearest project root marker.
fn project_root(file: &Path) -> PathBuf {
    let mut dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
    loop {
        let is_root = [
            "Cargo.toml",
            "tsconfig.json",
            "package.json",
            "go.mod",
            "pyproject.toml",
        ]
        .iter()
        .any(|m| dir.join(m).exists());
        if is_root {
            return dir;
        }
        if !dir.pop() {
            return file.parent().map(Path::to_path_buf).unwrap_or_default();
        }
    }
}

fn language_id_for(file: &Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()) {
        Some("rs") => "rust",
        Some("ts") => "typescript",
        Some("tsx") => "typescriptreact",
        Some("js") | Some("jsx") | Some("mjs") | Some("cjs") => "javascript",
        Some("go") => "go",
        Some("py") => "python",
        _ => "plaintext",
    }
}

/// Definition/references results can be a single Location, an array, or
/// an array of LocationLink. Normalize to `file:line:col` lines.
fn format_locations(result: &Value) -> String {
    let items: Vec<&Value> = match result {
        Value::Array(arr) => arr.iter().collect(),
        Value::Object(_) => vec![result],
        Value::Null => vec![],
        _ => vec![],
    };
    if items.is_empty() {
        return "no results".to_string();
    }
    let mut lines = Vec::new();
    for item in items {
        // LocationLink uses targetUri/targetRange.
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str);
        let pos = item
            .pointer("/range/start")
            .or_else(|| item.pointer("/targetSelectionRange/start"))
            .or_else(|| item.pointer("/targetRange/start"));
        if let (Some(uri), Some(pos)) = (uri, pos) {
            let path = uri.strip_prefix("file://").unwrap_or(uri);
            let line = pos.get("line").and_then(Value::as_i64).unwrap_or(0) + 1;
            let ch = pos.get("character").and_then(Value::as_i64).unwrap_or(0) + 1;
            lines.push(format!("{path}:{line}:{ch}"));
        }
    }
    if lines.is_empty() {
        "no results".to_string()
    } else {
        format!("{}\n({} locations)", lines.join("\n"), lines.len())
    }
}

/// Hover can be MarkedString[], MarkupContent, or {contents: string}.
fn format_hover(result: &Value) -> String {
    if result.is_null() {
        return "no hover info".to_string();
    }
    let contents = match result.get("contents") {
        Some(c) => c.clone(),
        None => result.clone(),
    };
    let text = match contents {
        Value::String(s) => s,
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p {
                Value::String(s) => Some(s.clone()),
                other => other.get("value").and_then(Value::as_str).map(String::from),
            })
            .collect::<Vec<_>>()
            .join("\n---\n"),
        obj => obj
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    if text.trim().is_empty() {
        "no hover info".to_string()
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_single_location() {
        let v = json!({
            "uri": "file:///a/src/lib.rs",
            "range": {"start": {"line": 9, "character": 3}}
        });
        assert_eq!(format_locations(&v), "/a/src/lib.rs:10:4\n(1 locations)");
    }

    #[test]
    fn formats_location_link_array() {
        let v = json!([{
            "targetUri": "file:///b/src/x.ts",
            "targetSelectionRange": {"start": {"line": 0, "character": 0}}
        }]);
        assert!(format_locations(&v).contains("/b/src/x.ts:1:1"));
    }

    #[test]
    fn formats_null_as_no_results() {
        assert_eq!(format_locations(&Value::Null), "no results");
    }

    #[test]
    fn hover_markup_content() {
        let v = json!({
            "contents": {"kind": "markdown", "value": "```rust\nfn foo()\n```"}
        });
        assert!(format_hover(&v).contains("fn foo()"));
    }

    #[test]
    fn hover_plain_string() {
        let v = json!({"contents": "int x"});
        assert_eq!(format_hover(&v), "int x");
    }

    #[test]
    fn project_root_walks_up() {
        let tmp = std::env::temp_dir().join(format!("lsp-root-{}", std::process::id()));
        let nested = tmp.join("crates/inner/src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(tmp.join("Cargo.toml"), "").unwrap();
        let root = project_root(&nested.join("main.rs"));
        assert_eq!(root, tmp);
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// Tool-level E2E against the mock language server: symbol
    /// resolution + didOpen + definition formatting. Skips when the
    /// mock script is unavailable.
    #[tokio::test]
    async fn tool_e2e_mock_definition() {
        let script = std::env::var("ARTERM_TEST_MOCK_LSP").ok().or_else(|| {
            let p =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../arterm-base/tests/mock_lsp.py");
            p.exists().then(|| p.to_string_lossy().into_owned())
        });
        let Some(script) = script else {
            eprintln!("skipping: mock LSP server not found");
            return;
        };
        // Rust 2024: set_var is unsafe in tests.
        unsafe { std::env::set_var("ARTERM_TEST_MOCK_LSP", &script) };
        let tmp = std::env::temp_dir().join(format!("lsp-tool-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Cargo.toml"), "").unwrap();
        let src = tmp.join("src/main.rs");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, "fn main() {\n    let target = foo();\n}\n").unwrap();

        let ctx = ToolContext {
            session_id: "test".into(),
            message_id: "test".into(),
            tool_call_id: "test-call".into(),
            working_dir: Some(tmp.clone()),
            stdin_request_tx: None,
            graceful_shutdown_signal: None,
            execution_mode: crate::tool::ToolExecutionMode::Direct,
            sandbox_mode: "full-access".into(),
        };
        let out = LspTool::new()
            .execute(
                serde_json::json!({
                    "action": "definition",
                    "file": "src/main.rs",
                    "symbol": "target",
                    "intent": "test"
                }),
                ctx,
            )
            .await
            .expect("execute");
        assert!(
            out.output.contains("/lib/src/defs.rs:11:5"),
            "got: {}",
            out.output
        );
        unsafe { std::env::remove_var("ARTERM_TEST_MOCK_LSP") };
        std::fs::remove_dir_all(&tmp).ok();
    }
}
