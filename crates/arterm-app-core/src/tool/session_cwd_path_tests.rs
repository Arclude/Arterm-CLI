//! Runtime checks that filesystem tools resolve the same relative path string
//! against session `working_dir`, not the server process cwd.

use super::{
    Tool, ToolContext, ToolExecutionMode, diagnostics::DiagnosticsTool, ls::LsTool, read::ReadTool,
    repo_map::RepoMapTool,
};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn process_cwd_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct CwdGuard {
    previous: PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl CwdGuard {
    fn chdir_to(decoy: &Path) -> Self {
        let lock = process_cwd_lock();
        let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        std::env::set_current_dir(decoy).expect("chdir to decoy");
        Self {
            previous,
            _lock: lock,
        }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let fallback = PathBuf::from("/");
        let target = if self.previous.exists() {
            self.previous.as_path()
        } else {
            fallback.as_path()
        };
        let _ = std::env::set_current_dir(target);
    }
}

fn test_ctx(root: &Path) -> ToolContext {
    ToolContext {
        session_id: "cwd-path".to_string(),
        message_id: "cwd-path".to_string(),
        tool_call_id: "cwd-path".to_string(),
        working_dir: Some(root.to_path_buf()),
        stdin_request_tx: None,
            ask_user_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: ToolExecutionMode::Direct,
    }
}

fn session_and_decoy() -> (tempfile::TempDir, tempfile::TempDir, CwdGuard) {
    let session = tempfile::tempdir().expect("session");
    let decoy = tempfile::tempdir().expect("decoy");

    fs::create_dir_all(session.path().join("src")).expect("session src");
    fs::write(
        session.path().join("src/app.rs"),
        "pub fn session_marker() {}\n",
    )
    .expect("session file");
    fs::write(
        session.path().join("Cargo.toml"),
        "[package]\nname=\"s\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
    )
    .expect("session cargo");

    fs::create_dir_all(decoy.path().join("src")).expect("decoy src");
    fs::write(
        decoy.path().join("src/app.rs"),
        "pub fn decoy_marker() {}\n",
    )
    .expect("decoy file");
    fs::write(
        decoy.path().join("Cargo.toml"),
        "[package]\nname=\"d\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
    )
    .expect("decoy cargo");

    let guard = CwdGuard::chdir_to(decoy.path());
    (session, decoy, guard)
}

#[test]
fn tool_context_resolve_path_ignores_process_cwd() {
    let (session, _decoy, _cwd) = session_and_decoy();
    let ctx = test_ctx(session.path());

    let relative = "src/app.rs";
    let resolved = ctx.resolve_path(Path::new(relative));
    assert_eq!(resolved, session.path().join(relative));
    assert!(resolved.is_file());

    // Empty string joins to the session root.
    assert_eq!(ctx.resolve_path(Path::new("")), session.path());

    // Absolute paths pass through even with a session cwd.
    let abs = session.path().join("src/app.rs");
    assert_eq!(ctx.resolve_path(&abs), abs);

    // Missing working_dir + absolute still works; relative stays relative.
    let mut no_wd = test_ctx(session.path());
    no_wd.working_dir = None;
    assert_eq!(no_wd.resolve_path(&abs), abs);
    assert_eq!(
        no_wd.resolve_path(Path::new("src/app.rs")),
        PathBuf::from("src/app.rs")
    );
}

#[tokio::test]
async fn read_and_ls_resolve_relative_path_via_session_working_dir() {
    let (session, _decoy, _cwd) = session_and_decoy();
    let ctx = test_ctx(session.path());

    let read = ReadTool::new()
        .execute(json!({"file_path": "src/app.rs"}), ctx.clone())
        .await
        .expect("read");
    assert!(
        read.output.contains("session_marker"),
        "read must open session file, got: {}",
        read.output
    );
    assert!(!read.output.contains("decoy_marker"), "{}", read.output);

    let ls = LsTool::new()
        .execute(json!({"path": "src"}), ctx.clone())
        .await
        .expect("ls");
    assert!(
        ls.output.contains("app.rs"),
        "ls must list session src, got: {}",
        ls.output
    );
    assert!(!ls.output.contains("decoy_marker"), "{}", ls.output);

    // path="" resolves to session root via resolve_path.
    let ls_empty = LsTool::new()
        .execute(json!({"path": ""}), ctx)
        .await
        .expect("ls empty path");
    assert!(
        ls_empty.output.contains("src") || ls_empty.output.contains("Cargo.toml"),
        "empty path should list session root: {}",
        ls_empty.output
    );
}

#[tokio::test]
async fn repo_map_relative_path_joins_session_working_dir() {
    let (session, decoy, _cwd) = session_and_decoy();
    let ctx = test_ctx(session.path());

    let out = RepoMapTool::new()
        .execute(
            json!({"intent": "probe relative path", "path": "src", "tree_only": true}),
            ctx,
        )
        .await
        .expect("repo_map");

    assert!(
        out.output
            .contains(&session.path().join("src").display().to_string()),
        "repo_map relative path should resolve via session working_dir, got: {}",
        out.output
    );
    assert!(
        !out.output
            .contains(&decoy.path().join("src").display().to_string()),
        "repo_map must not follow process cwd for relative path: {}",
        out.output
    );
}

#[tokio::test]
async fn diagnostics_relative_path_joins_session_working_dir() {
    let (session, decoy, _cwd) = session_and_decoy();
    let ctx = test_ctx(session.path());

    let out = DiagnosticsTool::new()
        .execute(json!({"intent": "probe relative path", "path": "."}), ctx)
        .await
        .expect("diagnostics");

    assert!(
        !out.output
            .contains(decoy.path().display().to_string().as_str()),
        "diagnostics relative path must not follow process cwd, got: {}",
        out.output
    );
}

#[tokio::test]
async fn repo_map_and_diagnostics_honor_working_dir_when_path_omitted() {
    let (session, _decoy, _cwd) = session_and_decoy();
    let ctx = test_ctx(session.path());

    let map = RepoMapTool::new()
        .execute(
            json!({"intent": "default to working_dir", "tree_only": true}),
            ctx.clone(),
        )
        .await
        .expect("repo_map default");
    assert!(
        map.output
            .contains(session.path().display().to_string().as_str())
            || map.output.contains("app.rs")
            || map.output.contains("src"),
        "omitted path should use working_dir: {}",
        map.output
    );
    assert!(!map.output.contains("decoy_marker"), "{}", map.output);

    let diag = DiagnosticsTool::new()
        .execute(json!({"intent": "default to working_dir"}), ctx)
        .await
        .expect("diagnostics default");
    assert!(
        diag.output
            .contains(session.path().display().to_string().as_str())
            || !diag.output.contains("decoy_marker"),
        "omitted path should use working_dir: {}",
        diag.output
    );
}

#[tokio::test]
async fn missing_working_dir_absolute_paths_succeed_for_read_and_ls() {
    let temp = tempfile::tempdir().expect("temp");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    let file = temp.path().join("src/app.rs");
    fs::write(&file, "pub fn absolute_only() {}\n").expect("write");

    let mut ctx = test_ctx(temp.path());
    ctx.working_dir = None;

    let read = ReadTool::new()
        .execute(
            json!({"file_path": file.display().to_string()}),
            ctx.clone(),
        )
        .await
        .expect("absolute read");
    assert!(read.output.contains("absolute_only"), "{}", read.output);

    let ls = LsTool::new()
        .execute(
            json!({"path": temp.path().join("src").display().to_string()}),
            ctx,
        )
        .await
        .expect("absolute ls");
    assert!(ls.output.contains("app.rs"), "{}", ls.output);
}
