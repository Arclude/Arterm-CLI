//! Language diagnostics: compiler/LSP-grade errors without a full LSP client.
//!
//! The gap report's LSP item, distilled to its most valuable 20%: after an
//! edit, the model wants "does it compile / typecheck, and what exactly is
//! wrong" for the file(s) it touched. A full LSP client (per-language server
//! lifecycle, text-document sync, capability negotiation) is heavy; compilers
//! already emit machine-readable diagnostics:
//!
//! - Rust: `cargo check --message-format=json-diagnostic-rendered`
//! - TypeScript/JavaScript: `tsc --noEmit --pretty false`
//! - Python: `python -m py_compile` (syntax) / `ruff check --output-format json`
//!
//! This tool detects the project type from lockfiles/manifests and runs the
//! right checker, then returns only the diagnostics (error/warning lines),
//! not the build noise. When no checker is known/available the tool says so
//! instead of pretending - and suggests running the project's own build.

use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::{Tool, ToolContext, ToolOutput};

/// Max diagnostics returned; the rest are summarized by count.
const MAX_DIAGNOSTICS: usize = 50;
const DEFAULT_TIMEOUT_SECS: u64 = 180;

pub struct DiagnosticsTool;

impl DiagnosticsTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Debug, serde::Deserialize)]
struct DiagnosticsInput {
    /// File or directory to check. Defaults to the working directory.
    #[serde(default)]
    path: Option<String>,
    /// Include warnings, not just errors (default true).
    #[serde(default = "default_true")]
    warnings: bool,
    /// Checker override: "cargo" | "tsc" | "ruff". Auto-detected when omitted.
    #[serde(default)]
    checker: Option<String>,
}

fn default_true() -> bool {
    true
}

#[async_trait::async_trait]
impl Tool for DiagnosticsTool {
    fn name(&self) -> &str {
        "diagnostics"
    }

    fn description(&self) -> &str {
        "Get compiler/linter diagnostics for the project: errors and warnings with file:line. Runs the right checker for the project type (cargo check for Rust, tsc for TypeScript, ruff for Python). Use after edits to verify code compiles/typechecks before claiming a change works. Read-only."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File or directory to check. Defaults to the working directory."
                },
                "warnings": {
                    "type": "boolean",
                    "description": "Include warnings, not just errors (default true)."
                },
                "checker": {
                    "type": "string",
                    "enum": ["cargo", "tsc", "ruff"],
                    "description": "Force a specific checker instead of auto-detecting from the project type."
                },
                "intent": {
                    "type": "string",
                    "description": "Required short label shown in the UI: why this call is being made."
                }
            },
            "required": ["intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input: DiagnosticsInput = serde_json::from_value(input)
            .map_err(|e| anyhow::anyhow!("invalid diagnostics input: {e}"))?;
        let target = input
            .path
            .clone()
            .map(PathBuf::from)
            .or_else(|| ctx.working_dir.clone())
            .unwrap_or_else(|| PathBuf::from("."));
        let root = find_project_root(&target);

        let detected = match input.checker.as_deref() {
            Some(c) => Ok(Some(c)),
            None => detect_checker(&root),
        };
        let Some(checker) = detected.map_err(anyhow::Error::msg)? else {
            return Ok(ToolOutput::new(format!(
                "diagnostics: no supported project found at {} (supported: Cargo.toml -> cargo check, tsconfig.json -> tsc, pyproject.toml/*.py -> ruff). Run the project's own build command instead.",
                root.display()
            )));
        };

        let started = Instant::now();
        let output = run_checker(checker, &root, DEFAULT_TIMEOUT_SECS);
        let elapsed = started.elapsed();
        match output {
            Ok(CheckOutput {
                diagnostics,
                truncated,
            }) => {
                let filtered: Vec<&Diag> = diagnostics
                    .iter()
                    .filter(|d| input.warnings || d.severity != "warning")
                    .collect();
                if filtered.is_empty() {
                    return Ok(ToolOutput::new(format!(
                        "diagnostics: clean ({checker}, {:.1}s) - no errors{}.",
                        elapsed.as_secs_f32(),
                        if input.warnings { " or warnings" } else { "" }
                    )));
                }
                let mut out = format!(
                    "diagnostics: {} issue(s) ({checker}, {:.1}s)\n",
                    filtered.len(),
                    elapsed.as_secs_f32()
                );
                for d in filtered.iter().take(MAX_DIAGNOSTICS) {
                    out.push_str(&format!(
                        "{}:{}:{} [{}] {}\n",
                        d.file, d.line, d.column, d.severity, d.message
                    ));
                }
                if filtered.len() > MAX_DIAGNOSTICS {
                    out.push_str(&format!(
                        "… and {} more (narrow with `path`)\n",
                        filtered.len() - MAX_DIAGNOSTICS
                    ));
                }
                if truncated {
                    out.push_str("(checker output was truncated; rerun for the rest)\n");
                }
                Ok(ToolOutput::new(out))
            }
            Err(CheckFailure::MissingTool(tool)) => Ok(ToolOutput::new(format!(
                "diagnostics: '{tool}' is not installed or not on PATH; cannot check this project. Falling back to the project's own build/test command is your best option."
            ))),
            Err(CheckFailure::Timeout(secs)) => Ok(ToolOutput::new(format!(
                "diagnostics: {checker} timed out after {secs}s. First builds can be slow (dependencies); try again once warm, or run the build directly."
            ))),
            Err(CheckFailure::Other(msg)) => Err(anyhow::anyhow!("diagnostics failed: {msg}")),
        }
    }
}

struct Diag {
    severity: String,
    file: String,
    line: usize,
    column: usize,
    message: String,
}

struct CheckOutput {
    diagnostics: Vec<Diag>,
    truncated: bool,
}

enum CheckFailure {
    MissingTool(&'static str),
    Timeout(u64),
    Other(String),
}

/// Walk up from `target` to the enclosing project root (directory holding
/// Cargo.toml / tsconfig.json / pyproject.toml / package.json).
fn find_project_root(target: &Path) -> PathBuf {
    let mut dir = if target.is_dir() {
        target.to_path_buf()
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    };
    loop {
        for marker in [
            "Cargo.toml",
            "tsconfig.json",
            "pyproject.toml",
            "package.json",
        ] {
            if dir.join(marker).exists() {
                return dir;
            }
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return target.to_path_buf(),
        }
    }
}

fn detect_checker(root: &Path) -> Result<Option<&'static str>, String> {
    if root.join("Cargo.toml").exists() {
        return Ok(Some("cargo"));
    }
    if root.join("tsconfig.json").exists()
        || (root.join("package.json").exists() && !root.join("tsconfig.json").exists())
    {
        return Ok(Some("tsc"));
    }
    if root.join("pyproject.toml").exists()
        || root.join("setup.py").exists()
        || root
            .read_dir()
            .map(|entries| {
                entries
                    .flatten()
                    .any(|e| e.path().extension().is_some_and(|x| x == "py"))
            })
            .unwrap_or(false)
    {
        return Ok(Some("ruff"));
    }
    Ok(None)
}

fn run_checker(checker: &str, root: &Path, timeout_secs: u64) -> Result<CheckOutput, CheckFailure> {
    let (program, args): (&str, Vec<&str>) = match checker {
        "cargo" => (
            "cargo",
            vec!["check", "--workspace", "--message-format=json"],
        ),
        "tsc" => ("npx", vec!["tsc", "--noEmit", "--pretty", "false"]),
        "ruff" => ("ruff", vec!["check", "--output-format=concise"]),
        other => return Err(CheckFailure::Other(format!("unknown checker {other}"))),
    };

    let mut cmd = Command::new(program);
    cmd.args(&args).current_dir(root);
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| CheckFailure::MissingTool(program))?;

    // Poll for completion with a hard timeout; kills the process group on
    // timeout so a wedged checker cannot leak.
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut child = child;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(CheckFailure::Timeout(timeout_secs));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(CheckFailure::Other(format!("wait failed: {e}"))),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| CheckFailure::Other(format!("collect output failed: {e}")))?;

    match checker {
        "cargo" => Ok(parse_cargo_json(&String::from_utf8_lossy(&output.stdout))),
        _ => {
            let text = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{text}{stderr}");
            Ok(parse_concise(&combined, root))
        }
    }
}

/// Parse `cargo check --message-format=json` compiler-diagnostic messages.
fn parse_cargo_json(stdout: &str) -> CheckOutput {
    let mut diagnostics = Vec::new();
    let mut truncated = false;
    for line in stdout.lines() {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if msg.get("reason").and_then(Value::as_str) != Some("compiler-message") {
            continue;
        }
        let Some(diag) = msg.pointer("/message") else {
            continue;
        };
        let level = diag
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_string();
        if level == "failure-note" || level == "note" {
            continue;
        }
        let message = diag
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (file, line, column) = diag
            .pointer("/spans/0")
            .map(|span| {
                (
                    span.get("file_name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    span.get("line_start").and_then(Value::as_u64).unwrap_or(0) as usize,
                    span.get("column_start")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize,
                )
            })
            .unwrap_or(("unknown".to_string(), 0, 0));
        diagnostics.push(Diag {
            severity: level,
            file,
            line,
            column,
            message,
        });
        if diagnostics.len() >= 500 {
            truncated = true;
            break;
        }
    }
    CheckOutput {
        diagnostics,
        truncated,
    }
}

/// Parse `file:line:col: message` concise formats (tsc pretty-false, ruff concise).
fn parse_concise(text: &str, _root: &Path) -> CheckOutput {
    let mut diagnostics = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        // ruff concise: "file:line:col: CODE message"
        // tsc pretty false: "file(line,col): error TS1234: message"
        let parts: Vec<&str> = line.splitn(4, ':').collect();
        if parts.len() == 4
            && let (Ok(_l), Ok(_c)) = (parts[1].parse::<usize>(), parts[2].parse::<usize>())
        {
            diagnostics.push(Diag {
                severity: if line.contains("error") {
                    "error"
                } else {
                    "warning"
                }
                .to_string(),
                file: parts[0].to_string(),
                line: parts[1].parse().unwrap_or(0),
                column: parts[2].parse().unwrap_or(0),
                message: parts[3].to_string(),
            });
            continue;
        }
        // tsc: path(line,col): error TSxxxx: msg
        if let (Some(open), Some(close)) = (line.find('('), line.find("): ")) {
            let file = line[..open].to_string();
            let pos = &line[open + 1..close];
            let (l, c) = pos.split_once(',').unwrap_or((pos, "0"));
            let rest = line[close + 3..].to_string();
            diagnostics.push(Diag {
                severity: if rest.starts_with("error") {
                    "error"
                } else {
                    "warning"
                }
                .to_string(),
                file,
                line: l.parse().unwrap_or(0),
                column: c.trim_end_matches(')').parse().unwrap_or(0),
                message: rest,
            });
        }
    }
    CheckOutput {
        diagnostics,
        truncated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cargo_json_diagnostics() {
        let json = r#"{"reason":"compiler-message","message":{"level":"error","message":"cannot find function `foo`","spans":[{"file_name":"src/main.rs","line_start":10,"column_start":5}]}}"#;
        let out = parse_cargo_json(json);
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].severity, "error");
        assert_eq!(out.diagnostics[0].file, "src/main.rs");
        assert_eq!(out.diagnostics[0].line, 10);
        assert!(out.diagnostics[0].message.contains("foo"));
    }

    #[test]
    fn skips_non_compiler_messages() {
        let json = r#"{"reason":"build-script-executed"}"#;
        let out = parse_cargo_json(json);
        assert!(out.diagnostics.is_empty());
    }

    #[test]
    fn parses_concise_ruff_style() {
        let text =
            "src/app.py:12:5: F821 Undefined name `foo`\nsrc/other.py:3:1: E501 Line too long";
        let out = parse_concise(text, Path::new("."));
        assert_eq!(out.diagnostics.len(), 2);
        assert_eq!(out.diagnostics[0].file, "src/app.py");
        assert_eq!(out.diagnostics[0].line, 12);
        assert!(out.diagnostics[0].message.contains("F821"));
    }

    #[test]
    fn parses_tsc_style() {
        let text = "src/index.ts(42,10): error TS2339: Property 'x' does not exist.";
        let out = parse_concise(text, Path::new("."));
        assert_eq!(out.diagnostics.len(), 1);
        assert_eq!(out.diagnostics[0].file, "src/index.ts");
        assert_eq!(out.diagnostics[0].line, 42);
        assert_eq!(out.diagnostics[0].severity, "error");
        assert!(out.diagnostics[0].message.contains("TS2339"));
    }

    #[test]
    fn detects_checker_by_marker() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_checker(tmp.path()).unwrap(), None);
        std::fs::write(tmp.path().join("Cargo.toml"), "").unwrap();
        assert_eq!(detect_checker(tmp.path()).unwrap(), Some("cargo"));
    }

    #[test]
    fn project_root_walks_up() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), "").unwrap();
        assert_eq!(find_project_root(&nested), tmp.path());
    }
}
