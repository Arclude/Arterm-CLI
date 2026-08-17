//! Git worktree isolation for spawned agents.
//!
//! When a subagent works on a branch of changes, running it in its own
//! `git worktree` lets it build and test freely without racing the
//! coordinator's checkout (or other workers) on the same files. The spawn
//! path already carries a `working_dir`, so isolation is implemented by
//! creating a worktree before spawn and passing its path instead.
//!
//! Worktrees are created under `<repo>/.arterm/worktrees/<name>` with a new
//! branch `arterm/<name>` off HEAD, so they are ordinary git state: `git
//! worktree list` shows them, `git worktree remove` cleans them, and nothing
//! is hidden from the user.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Result of preparing an isolated worktree.
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    /// The worktree directory to use as the agent's working dir.
    pub path: PathBuf,
    /// The branch created for this worktree (`arterm/<name>`).
    pub branch: String,
}

/// Create an isolated worktree for `name` off `base_repo`'s HEAD.
///
/// Fails (rather than silently degrading) when `base_repo` is not a git
/// repository or git is unavailable: callers should surface the error and
/// fall back to a non-isolated spawn only if the user's policy allows it.
pub fn create_worktree(base_repo: &Path, name: &str) -> Result<Worktree, String> {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let slug = format!(
        "{}-{}",
        sanitized,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );
    let branch = format!("arterm/{slug}");
    let worktree_path = base_repo.join(".arterm").join("worktrees").join(&slug);

    let output = Command::new("git")
        .arg("-C")
        .arg(base_repo)
        .args(["worktree", "add", "-b", &branch])
        .arg(&worktree_path)
        .arg("HEAD")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(Worktree {
        path: worktree_path,
        branch,
    })
}

/// Remove a worktree previously created by [`create_worktree`] and delete its
/// branch. Best-effort: errors are returned but never block shutdown paths.
pub fn remove_worktree(base_repo: &Path, worktree: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(base_repo)
        .args(["worktree", "remove", "--force"])
        .arg(worktree)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Locate the git repository root containing `dir` (following `git rev-parse
/// --show-toplevel`), or `None` when `dir` is not inside a work tree.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let top = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if top.is_empty() {
        None
    } else {
        Some(PathBuf::from(top))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn repo_root_finds_toplevel_and_rejects_non_repos() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        assert!(repo_root(tmp.path()).is_none());

        let out = Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(out.status.success());
        let root = repo_root(tmp.path()).expect("repo root after init");
        assert_eq!(
            root.canonicalize().unwrap(),
            tmp.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn create_and_remove_worktree_roundtrip() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(["init", "-q"])
            .output()
            .unwrap();
        std::fs::write(tmp.path().join("seed.txt"), "seed\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .args(["commit", "-q", "-m", "seed"])
            .output()
            .unwrap();

        let wt = create_worktree(tmp.path(), "worker one!").expect("worktree");
        assert!(wt.path.is_dir(), "worktree dir must exist");
        assert!(
            wt.path.join("seed.txt").exists(),
            "worktree must carry HEAD content"
        );
        assert!(
            wt.branch.starts_with("arterm/worker-one"),
            "branch: {}",
            wt.branch
        );

        remove_worktree(tmp.path(), &wt.path).expect("remove");
        assert!(!wt.path.exists(), "worktree dir must be gone after remove");
    }
}
