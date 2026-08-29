//! GitHub issues / PRs via the `gh` CLI.
//!
//! Uses the user's existing `gh` auth (same token source as
//! `github_public_api_token`). When `gh` is missing or unauthenticated the
//! tool reports the install/login hint instead of failing silently.

use anyhow::Result;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use super::{Tool, ToolContext, ToolOutput};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_ITEMS: usize = 30;

pub struct GithubTool;

impl GithubTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GithubTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, serde::Deserialize)]
struct GithubInput {
    /// Action: issues | prs | issue | pr | comment
    action: String,
    /// Repo as owner/name. Defaults to the git remote of the working dir.
    #[serde(default)]
    repo: Option<String>,
    /// Issue/PR number for issue, pr, comment.
    #[serde(default)]
    number: Option<u64>,
    /// Search / list filter (e.g. "is:open label:bug").
    #[serde(default)]
    query: Option<String>,
    /// Comment body (action=comment).
    #[serde(default)]
    body: Option<String>,
}

#[async_trait::async_trait]
impl Tool for GithubTool {
    fn name(&self) -> &str {
        "github"
    }

    fn description(&self) -> &str {
        "List or view GitHub issues and PRs, or comment on one. Uses gh."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["issues", "prs", "issue", "pr", "comment"],
                    "description": "issues/prs: list. issue/pr: view one. comment: add a comment."
                },
                "repo": {
                    "type": "string",
                    "description": "owner/name. Defaults to the working dir's git remote."
                },
                "number": {
                    "type": "integer",
                    "description": "Issue or PR number for issue, pr, comment."
                },
                "query": {
                    "type": "string",
                    "description": "List filter, e.g. is:open label:bug."
                },
                "body": {
                    "type": "string",
                    "description": "Comment body (required for action=comment)."
                },
                "intent": {
                    "type": "string",
                    "description": "Required short label shown in the UI: why this call is being made."
                }
            },
            "required": ["action", "intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input: GithubInput = serde_json::from_value(input)
            .map_err(|e| anyhow::anyhow!("invalid github input: {e}"))?;

        if !command_exists(&gh_bin()) {
            return Ok(ToolOutput::new(
                "github: `gh` is not on PATH. Install GitHub CLI (https://cli.github.com) and run `gh auth login`."
                    .to_string(),
            ));
        }

        let cwd = ctx
            .working_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("."));
        let repo = match input.repo.as_deref() {
            Some(r) if !r.trim().is_empty() => r.trim().to_string(),
            _ => match detect_repo(&cwd) {
                Ok(r) => r,
                Err(e) => {
                    return Ok(ToolOutput::new(format!(
                        "github: could not detect repo from {cwd}: {e}. Pass `repo` as owner/name.",
                        cwd = cwd.display()
                    )));
                }
            },
        };

        let out = match input.action.as_str() {
            "issues" => list_items(&repo, "issue", input.query.as_deref())?,
            "prs" => list_items(&repo, "pr", input.query.as_deref())?,
            "issue" => view_item(&repo, "issue", required_number(input.number)?)?,
            "pr" => view_item(&repo, "pr", required_number(input.number)?)?,
            "comment" => {
                let number = required_number(input.number)?;
                let body = input
                    .body
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!("github: `body` is required for action=comment")
                    })?;
                add_comment(&repo, number, body)?
            }
            other => {
                anyhow::bail!("github: unknown action `{other}` (issues|prs|issue|pr|comment)")
            }
        };
        Ok(ToolOutput::new(out))
    }
}

fn required_number(n: Option<u64>) -> Result<u64> {
    n.ok_or_else(|| anyhow::anyhow!("github: `number` is required for this action"))
}

/// `ARTERM_TEST_MOCK_GH` points at a test double so unit tests never mutate PATH.
fn gh_bin() -> String {
    std::env::var("ARTERM_TEST_MOCK_GH")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gh".into())
}

fn command_exists(name: &str) -> bool {
    let path = std::path::Path::new(name);
    if path.is_absolute() || name.contains('/') || name.contains('\\') {
        return path.is_file();
    }
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                if dir.join(name).is_file() {
                    return true;
                }
                #[cfg(windows)]
                {
                    if dir.join(format!("{name}.exe")).is_file() {
                        return true;
                    }
                }
                false
            })
        })
        .unwrap_or(false)
}

fn detect_repo(cwd: &std::path::Path) -> Result<String> {
    let output = run_gh(
        cwd,
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ],
    )?;
    let repo = output.trim().to_string();
    if repo.is_empty() || repo.contains(' ') {
        anyhow::bail!("unexpected `gh repo view` output: {repo}");
    }
    Ok(repo)
}

fn list_items(repo: &str, kind: &str, query: Option<&str>) -> Result<String> {
    let mut args = vec![
        kind.to_string(),
        "list".into(),
        "--repo".into(),
        repo.into(),
        "--limit".into(),
        MAX_ITEMS.to_string(),
        "--json".into(),
        "number,title,state,author,updatedAt,url,labels".into(),
    ];
    if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--search".into());
        args.push(q.into());
    }
    let raw = run_gh_args(&args)?;
    Ok(format_list(&raw, kind))
}

fn view_item(repo: &str, kind: &str, number: u64) -> Result<String> {
    let fields = match kind {
        "pr" => {
            "number,title,state,author,url,body,baseRefName,headRefName,additions,deletions,changedFiles,reviews,comments"
        }
        _ => "number,title,state,author,url,body,comments,labels",
    };
    let raw = run_gh_args(&[
        kind.to_string(),
        "view".into(),
        number.to_string(),
        "--repo".into(),
        repo.into(),
        "--json".into(),
        fields.into(),
    ])?;
    Ok(format_view(&raw, kind))
}

fn add_comment(repo: &str, number: u64, body: &str) -> Result<String> {
    // `gh issue comment` works for both issues and PRs.
    let raw = run_gh_args(&[
        "issue".into(),
        "comment".into(),
        number.to_string(),
        "--repo".into(),
        repo.into(),
        "--body".into(),
        body.into(),
    ])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Ok(format!("commented on {repo}#{number}"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn run_gh(cwd: &std::path::Path, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new(gh_bin());
    cmd.args(args).current_dir(cwd);
    run_command(cmd)
}

fn run_gh_args(args: &[String]) -> Result<String> {
    let mut cmd = Command::new(gh_bin());
    cmd.args(args);
    run_command(cmd)
}

fn run_command(mut cmd: Command) -> Result<String> {
    let started = std::time::Instant::now();
    let output = cmd.output().map_err(|e| {
        anyhow::anyhow!("github: failed to spawn `gh`: {e}. Is GitHub CLI installed?")
    })?;
    if started.elapsed() > Duration::from_secs(DEFAULT_TIMEOUT_SECS) {
        anyhow::bail!("github: `gh` timed out after {DEFAULT_TIMEOUT_SECS}s");
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("unknown error");
        anyhow::bail!("github: gh failed: {detail}");
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Format `gh issue/pr list --json` output as numbered lines.
pub fn format_list(raw: &str, kind: &str) -> String {
    let items: Vec<Value> = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.trim().to_string(),
    };
    if items.is_empty() {
        return format!("no {kind}s");
    }
    let mut lines = Vec::new();
    for item in &items {
        let number = item.get("number").and_then(Value::as_u64).unwrap_or(0);
        let title = item.get("title").and_then(Value::as_str).unwrap_or("");
        let state = item.get("state").and_then(Value::as_str).unwrap_or("");
        let author = item
            .pointer("/author/login")
            .and_then(Value::as_str)
            .unwrap_or("-");
        let labels = item
            .get("labels")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("name").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .filter(|s| !s.is_empty())
            .map(|s| format!(" [{s}]"))
            .unwrap_or_default();
        lines.push(format!("#{number} {state} @{author}{labels} {title}"));
    }
    format!("{}\n({} {kind}s)", lines.join("\n"), items.len())
}

/// Format `gh issue/pr view --json` as a compact card.
pub fn format_view(raw: &str, kind: &str) -> String {
    let item: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.trim().to_string(),
    };
    let number = item.get("number").and_then(Value::as_u64).unwrap_or(0);
    let title = item.get("title").and_then(Value::as_str).unwrap_or("");
    let state = item.get("state").and_then(Value::as_str).unwrap_or("");
    let author = item
        .pointer("/author/login")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let url = item.get("url").and_then(Value::as_str).unwrap_or("");
    let body = item
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let body = if body.is_empty() {
        "(no body)".to_string()
    } else if body.len() > 2000 {
        format!("{}…", &body[..2000])
    } else {
        body.to_string()
    };

    let mut extra = String::new();
    if kind == "pr" {
        let base = item
            .get("baseRefName")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let head = item
            .get("headRefName")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let adds = item.get("additions").and_then(Value::as_u64).unwrap_or(0);
        let dels = item.get("deletions").and_then(Value::as_u64).unwrap_or(0);
        let files = item
            .get("changedFiles")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        extra = format!("\n{head} → {base}  +{adds}/-{dels} in {files} files");
    }

    format!("#{number} {state} @{author} {title}\n{url}{extra}\n\n{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn format_list_empty() {
        assert_eq!(format_list("[]", "issue"), "no issues");
    }

    #[test]
    fn format_list_items() {
        let raw = json!([
            {
                "number": 12,
                "title": "fix login",
                "state": "OPEN",
                "author": {"login": "alice"},
                "labels": [{"name": "bug"}]
            }
        ])
        .to_string();
        let out = format_list(&raw, "issue");
        assert!(out.contains("#12 OPEN @alice [bug] fix login"), "{out}");
        assert!(out.contains("(1 issues)"), "{out}");
    }

    #[test]
    fn format_view_issue() {
        let raw = json!({
            "number": 3,
            "title": "hello",
            "state": "OPEN",
            "author": {"login": "bob"},
            "url": "https://github.com/o/r/issues/3",
            "body": "please look"
        })
        .to_string();
        let out = format_view(&raw, "issue");
        assert!(out.contains("#3 OPEN @bob hello"), "{out}");
        assert!(out.contains("please look"), "{out}");
        assert!(out.contains("https://github.com/o/r/issues/3"), "{out}");
    }

    #[test]
    fn format_view_pr_includes_diffstat() {
        let raw = json!({
            "number": 9,
            "title": "feat",
            "state": "OPEN",
            "author": {"login": "carol"},
            "url": "https://github.com/o/r/pull/9",
            "body": "",
            "baseRefName": "main",
            "headRefName": "feat/x",
            "additions": 10,
            "deletions": 2,
            "changedFiles": 3
        })
        .to_string();
        let out = format_view(&raw, "pr");
        assert!(out.contains("feat/x → main  +10/-2 in 3 files"), "{out}");
        assert!(out.contains("(no body)"), "{out}");
    }

    #[test]
    fn format_list_passthrough_on_non_json() {
        assert_eq!(format_list("not json", "pr"), "not json");
    }

    /// Point `ARTERM_TEST_MOCK_GH` at a wrapper and run the tool end to end.
    #[tokio::test]
    async fn tool_e2e_mock_gh_lists_issues() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/mock_gh.py");
        if !script.exists() {
            eprintln!("skipping: mock_gh.py not found");
            return;
        }
        let bin_dir = std::env::temp_dir().join(format!("gh-mock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bin_dir);
        std::fs::create_dir_all(&bin_dir).unwrap();
        let dest = bin_dir.join("gh");
        let wrapper = format!("#!/bin/sh\nexec python3 {} \"$@\"\n", script.display());
        std::fs::write(&dest, wrapper).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms).unwrap();
        }

        let old_mock = std::env::var_os("ARTERM_TEST_MOCK_GH");
        unsafe {
            std::env::set_var("ARTERM_TEST_MOCK_GH", &dest);
        }

        let tmp = std::env::temp_dir().join(format!("gh-tool-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let ctx = ToolContext {
            session_id: "test".into(),
            message_id: "test".into(),
            tool_call_id: "test-call".into(),
            working_dir: Some(tmp.clone()),
            stdin_request_tx: None,
            ask_user_request_tx: None,
            graceful_shutdown_signal: None,
            execution_mode: crate::tool::ToolExecutionMode::Direct,
        };
        let out = GithubTool::new()
            .execute(
                serde_json::json!({
                    "action": "issues",
                    "intent": "test list"
                }),
                ctx,
            )
            .await
            .expect("execute");
        assert!(
            out.output.contains("#7 OPEN @alice [bug] fix login"),
            "got: {}",
            out.output
        );

        unsafe {
            match old_mock {
                Some(v) => std::env::set_var("ARTERM_TEST_MOCK_GH", v),
                None => std::env::remove_var("ARTERM_TEST_MOCK_GH"),
            }
        }
        let _ = std::fs::remove_dir_all(&bin_dir);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
