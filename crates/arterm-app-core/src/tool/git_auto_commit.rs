//! Git auto-commit: after each successful file-mutating tool, commit the
//! touched files so the user always has a repository-level undo point.
//!
//! Modeled after Aider's auto-commit: meaningful edits become commits the
//! moment they happen, with a machine-readable prefix so they are easy to
//! filter (`arterm:`). Safety rules:
//!
//! - Only the files the tool actually touched are staged, never
//!   `git add -A`: user's own in-progress work is not swept into the
//!   agent's commit.
//! - Commits land only in a repo whose HEAD is clean *of the touched
//!   files* beforehand; a touched file with pre-existing user changes is
//!   left uncommitted and reported instead.
//! - Detached HEAD and rebase/merge states are skipped and reported.
//! - Failure is always non-fatal: the edit itself already succeeded.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Commit prefix for every auto-commit this module creates.
pub const COMMIT_PREFIX: &str = "arterm:";

/// Result of an auto-commit attempt, for tool-output reporting.
#[derive(Debug)]
pub enum AutoCommitOutcome {
    /// Committed with the generated message.
    Committed(String),
    /// Nothing to do: feature disabled, not a repo, or no changes.
    Skipped(String),
    /// Refused for a safety reason (dirty baseline, rebase in progress...).
    Refused(String),
    /// Git itself failed.
    Failed(String),
}

/// Whether auto-commit is enabled for this run.
pub fn enabled() -> bool {
    // Test escape hatch: the config cache is throttled and file-backed,
    // so tests (and users) can force the behavior via the environment.
    if let Ok(v) = std::env::var("ARTERM_GIT_AUTO_COMMIT") {
        return matches!(v.as_str(), "1" | "true" | "yes" | "on");
    }
    crate::config::config().git_auto_commit
}

/// Commit `files` (paths relative or absolute under `workdir`) with a
/// message describing the tool that touched them.
pub fn commit_touched(workdir: &Path, tool_name: &str, files: &[PathBuf]) -> AutoCommitOutcome {
    if !enabled() {
        return AutoCommitOutcome::Skipped("auto-commit disabled".into());
    }
    if files.is_empty() {
        return AutoCommitOutcome::Skipped("no files touched".into());
    }
    if !workdir.join(".git").exists() && git(workdir, &["rev-parse", "--git-dir"]).is_none() {
        return AutoCommitOutcome::Skipped("not a git repository".into());
    }

    // Refuse in the middle of an unfinished operation; committing into a
    // merge/rebase would entangle the agent with the user's conflict.
    if workdir.join(".git").join("rebase-merge").exists()
        || workdir.join(".git").join("rebase-apply").exists()
        || workdir.join(".git").join("MERGE_HEAD").exists()
    {
        return AutoCommitOutcome::Refused("rebase/merge in progress; auto-commit skipped".into());
    }

    // Only the touched files are staged. Pre-existing modifications to
    // these same files are the user's work: check the pre-stage status of
    // each file and refuse if it was already modified before this tool ran.
    for file in files {
        let rel = match rel_to_workdir(workdir, file) {
            Some(rel) => rel,
            None => {
                return AutoCommitOutcome::Skipped(format!(
                    "{} is outside the repository",
                    file.display()
                ));
            }
        };
        if let Some(status) = git(workdir, &["status", "--porcelain", "--", &rel])
            && !status.is_empty()
            && !status.starts_with("??")
        {
            return AutoCommitOutcome::Refused(format!(
                "{rel} had uncommitted changes before this edit; \
leaving the commit to you",
            ));
        }
        if git(workdir, &["add", "--", &rel]).is_none() {
            return AutoCommitOutcome::Failed(format!("git add failed for {rel}"));
        }
    }

    // Anything staged?
    if git(workdir, &["diff", "--cached", "--quiet"]).is_some() {
        return AutoCommitOutcome::Skipped("no staged changes".into());
    }

    let message = format!("{COMMIT_PREFIX} {tool_name}: {} file(s)", files.len());
    match git(workdir, &["commit", "-m", &message]) {
        Some(_) => AutoCommitOutcome::Committed(message),
        None => {
            // Unstage on failure so we do not leave a dirty index.
            let _ = git(workdir, &["reset", "--quiet"]);
            AutoCommitOutcome::Failed("git commit failed".into())
        }
    }
}

/// Run git in `dir`, returning trimmed stdout on success (exit 0 with
/// output allowed to be empty only when `allow_empty` semantics are
/// expressed by the caller through the specific command).
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

/// Append a one-line notice about the auto-commit outcome to the tool
/// output. Silent for the common disabled/not-a-repo skips.
pub fn append_notice(body: &mut String, outcome: &AutoCommitOutcome) {
    match outcome {
        AutoCommitOutcome::Committed(msg) => {
            body.push_str(&format!("\n\nAuto-committed: {msg}"));
        }
        AutoCommitOutcome::Refused(reason) => {
            body.push_str(&format!("\n\nAuto-commit skipped: {reason}"));
        }
        AutoCommitOutcome::Failed(reason) => {
            body.push_str(&format!("\n\nAuto-commit failed: {reason}"));
        }
        AutoCommitOutcome::Skipped(_) => {}
    }
}

/// Path relative to `workdir`, when the file lives under it.
fn rel_to_workdir(workdir: &Path, file: &Path) -> Option<String> {
    let wd = std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf());
    let f = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    f.strip_prefix(&wd)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arterm-autocommit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            Command::new("git")
                .current_dir(&dir)
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        assert!(run(&["init", "-q"]));
        assert!(run(&["config", "user.email", "test@arterm.local"]));
        assert!(run(&["config", "user.name", "arterm test"]));
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        assert!(run(&["add", "."]));
        assert!(run(&["commit", "-qm", "seed"]));
        dir
    }

    #[test]
    fn commits_touched_file() {
        unsafe { std::env::set_var("ARTERM_GIT_AUTO_COMMIT", "1") };
        let dir = init_repo();
        let file = dir.join("touched.txt");
        std::fs::write(&file, "new content\n").unwrap();

        match commit_touched(&dir, "write", &[file]) {
            AutoCommitOutcome::Committed(msg) => assert!(msg.starts_with("arterm: write")),
            other => panic!("expected Committed, got {other:?}"),
        }
        let log = git(&dir, &["log", "-1", "--format=%s"]).unwrap();
        assert!(log.starts_with("arterm: write"));
        let status = git(&dir, &["status", "--porcelain"]).unwrap();
        assert!(status.is_empty(), "worktree should be clean, got: {status}");
        unsafe { std::env::remove_var("ARTERM_GIT_AUTO_COMMIT") };
    }

    #[test]
    fn refuses_when_file_was_already_dirty() {
        unsafe { std::env::set_var("ARTERM_GIT_AUTO_COMMIT", "1") };
        let dir = init_repo();
        let file = dir.join("seed.txt");
        std::fs::write(&file, "user's own edit\n").unwrap();

        match commit_touched(&dir, "edit", &[file]) {
            AutoCommitOutcome::Refused(msg) => {
                assert!(msg.contains("uncommitted changes"), "{msg}")
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        unsafe { std::env::remove_var("ARTERM_GIT_AUTO_COMMIT") };
    }

    #[test]
    fn skips_outside_repo() {
        unsafe { std::env::set_var("ARTERM_GIT_AUTO_COMMIT", "1") };
        let dir = std::env::temp_dir().join(format!(
            "arterm-autocommit-norepo-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x.txt");
        std::fs::write(&file, "x").unwrap();
        match commit_touched(&dir, "write", &[file]) {
            AutoCommitOutcome::Skipped(msg) => assert!(msg.contains("not a git repository")),
            other => panic!("expected Skipped, got {other:?}"),
        }
        unsafe { std::env::remove_var("ARTERM_GIT_AUTO_COMMIT") };
    }

    #[test]
    fn disabled_by_default_skips_silently() {
        unsafe { std::env::remove_var("ARTERM_GIT_AUTO_COMMIT") };
        let dir = init_repo();
        let file = dir.join("fresh.txt");
        std::fs::write(&file, "content\n").unwrap();
        match commit_touched(&dir, "write", &[file]) {
            AutoCommitOutcome::Skipped(msg) => assert!(msg.contains("disabled")),
            other => panic!("expected Skipped, got {other:?}"),
        }
    }
}
