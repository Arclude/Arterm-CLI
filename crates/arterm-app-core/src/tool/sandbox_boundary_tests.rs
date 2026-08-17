//! Tests for the in-process sandbox boundary.
//!
//! Two layers. The `Boundary` tests pin the path resolution and the mode
//! policy without touching the environment: they hand the boundary an explicit
//! set of writable roots, so "outside the workspace" means exactly that and
//! nothing else. The tool tests drive the real `write`/`edit`/`apply_patch`
//! tools through a `ToolContext`, which is where the bug actually lived.
//!
//! A trap worth naming: the real workspace-write policy also allows the system
//! temp directory, and test scaffolding lives in the temp directory. A test
//! that puts its "outside" location in `/tmp` while the boundary permits `/tmp`
//! proves nothing. The `Boundary` tests avoid it by granting only the
//! workspace; the tool tests avoid it by pointing `TMPDIR` at a directory that
//! contains neither the workspace nor the outside location.

use super::*;
use crate::tool::Tool;
use std::path::Path;

// ─── helpers ──────────────────────────────────────────────────────────────

/// A boundary whose only writable root is `workspace`.
fn workspace_only(workspace: &Path) -> Boundary {
    Boundary::new(
        SandboxMode::WorkspaceWrite,
        workspace.to_path_buf(),
        vec![workspace.to_path_buf()],
    )
}

fn is_allowed(boundary: &Boundary, path: &Path) -> bool {
    matches!(boundary.judge(path), GateOutcome::Allow)
}

fn refusal_message(boundary: &Boundary, path: &Path) -> String {
    match boundary.judge(path) {
        GateOutcome::Allow => {
            panic!("expected the boundary to refuse {}", path.display())
        }
        GateOutcome::Blocked { message, .. } => message,
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create symlink");
}

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().expect("workspace tempdir")
}

// ─── path resolution ──────────────────────────────────────────────────────

#[test]
fn a_new_file_in_an_existing_workspace_dir_is_allowed() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    assert!(is_allowed(&boundary, &ws.path().join("new.txt")));
}

#[test]
fn a_new_file_under_directories_that_do_not_exist_yet_is_allowed() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    assert!(is_allowed(
        &boundary,
        &ws.path().join("a").join("b").join("c").join("new.txt")
    ));
}

#[test]
fn a_relative_path_is_resolved_against_the_working_directory() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    assert!(is_allowed(&boundary, Path::new("src/main.rs")));
    assert!(!is_allowed(&boundary, Path::new("../../../etc/passwd")));
}

#[test]
fn a_parent_walk_out_of_the_workspace_is_refused() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    let escape = ws
        .path()
        .join("..")
        .join("..")
        .join("..")
        .join("etc/passwd");
    assert!(
        !is_allowed(&boundary, &escape),
        "`..` must be applied, not passed through"
    );
}

#[test]
fn a_parent_walk_through_missing_directories_is_still_refused() {
    // The nearest *existing* ancestor here is the workspace, so a check that
    // canonicalized it and then trusted the remainder would allow this.
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    let escape = ws.path().join("nope/deeper/../../../../etc/passwd");
    assert!(!is_allowed(&boundary, &escape));
}

#[test]
fn an_absolute_path_outside_the_workspace_is_refused() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    assert!(!is_allowed(&boundary, Path::new("/etc/passwd")));
}

#[test]
fn a_sibling_directory_sharing_a_name_prefix_is_refused() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    let sibling = ws.path().with_file_name(format!(
        "{}-evil",
        ws.path().file_name().unwrap().to_string_lossy()
    ));
    assert!(
        !is_allowed(&boundary, &sibling.join("file.txt")),
        "the root check must compare components, not string prefixes"
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_pointing_out_of_the_workspace_is_refused() {
    let ws = workspace();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), &ws.path().join("escape"));
    let boundary = workspace_only(ws.path());
    assert!(!is_allowed(&boundary, &ws.path().join("escape/loot.txt")));
}

#[cfg(unix)]
#[test]
fn a_dangling_symlink_pointing_out_of_the_workspace_is_refused() {
    // The hole a "canonicalize the nearest existing ancestor" check leaves:
    // `exists()` is false for a dangling link, so the link itself looks like
    // the not-yet-created file -- while the write follows it to /etc.
    let ws = workspace();
    let link = ws.path().join("dangling");
    symlink(Path::new("/etc/arterm-boundary-does-not-exist"), &link);
    let boundary = workspace_only(ws.path());
    assert!(!link.exists(), "the link target must not exist");
    assert!(!is_allowed(&boundary, &link));
}

#[cfg(unix)]
#[test]
fn a_symlink_that_stays_inside_the_workspace_is_allowed() {
    let ws = workspace();
    let real = ws.path().join("real");
    std::fs::create_dir_all(&real).unwrap();
    symlink(&real, &ws.path().join("alias"));
    let boundary = workspace_only(ws.path());
    assert!(
        is_allowed(&boundary, &ws.path().join("alias/file.txt")),
        "a symlink inside the workspace is legitimate use, not an escape"
    );
}

#[cfg(unix)]
#[test]
fn a_workspace_reached_through_a_symlink_recognises_its_own_files() {
    // The workspace root itself is given as a symlink (`/tmp` is one on
    // macOS). Its real files must still be inside the boundary.
    let real = workspace();
    let links = tempfile::tempdir().unwrap();
    let alias = links.path().join("workspace");
    symlink(real.path(), &alias);
    let boundary = workspace_only(&alias);
    assert!(is_allowed(&boundary, &alias.join("file.txt")));
    assert!(is_allowed(&boundary, &real.path().join("file.txt")));
}

#[cfg(unix)]
#[test]
fn a_parent_walk_applies_to_the_symlink_target_like_the_kernel_does() {
    // `link/..` is the *target's* parent, not the link's -- so a link out of
    // the workspace followed by `..` is still outside.
    let ws = workspace();
    let outside = tempfile::tempdir().unwrap();
    let nested = outside.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    symlink(&nested, &ws.path().join("escape"));
    let boundary = workspace_only(ws.path());
    assert!(!is_allowed(
        &boundary,
        &ws.path().join("escape/../loot.txt")
    ));
}

#[cfg(unix)]
#[test]
fn a_symlink_loop_is_refused_rather_than_judged_unresolved() {
    let ws = workspace();
    let first = ws.path().join("first");
    let second = ws.path().join("second");
    symlink(&second, &first);
    symlink(&first, &second);
    let boundary = workspace_only(ws.path());
    let message = refusal_message(&boundary, &first);
    assert!(
        message.contains("symbolic links"),
        "the refusal should say the path could not be resolved: {message}"
    );
}

// ─── the three modes ──────────────────────────────────────────────────────

#[test]
fn workspace_write_allows_the_workspace_and_refuses_everything_else() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    assert!(is_allowed(&boundary, &ws.path().join("inside.txt")));
    assert!(!is_allowed(&boundary, Path::new("/etc/passwd")));
}

#[test]
fn read_only_refuses_even_inside_the_workspace() {
    let ws = workspace();
    let boundary = Boundary::new(
        SandboxMode::Readonly,
        ws.path().to_path_buf(),
        writable_roots(SandboxMode::Readonly, Some(ws.path())),
    );
    assert!(!is_allowed(&boundary, &ws.path().join("inside.txt")));
    assert!(
        !is_allowed(&boundary, &std::env::temp_dir().join("scratch.txt")),
        "read-only modifies no files at all, temp included"
    );
}

#[test]
fn full_access_is_not_enforced_at_all() {
    let ws = workspace();
    let ctx = ctx_for(ws.path(), "full-access");
    assert!(matches!(
        check(&ctx, Path::new("/etc/passwd")),
        GateOutcome::Allow
    ));
}

#[test]
fn an_unparseable_mode_fails_open_exactly_like_bash() {
    let ws = workspace();
    let ctx = ctx_for(ws.path(), "wrokspace-write");
    assert!(matches!(
        check(&ctx, Path::new("/etc/passwd")),
        GateOutcome::Allow
    ));
}

#[test]
fn a_session_without_a_working_directory_is_confined_to_the_process_cwd() {
    let ws = workspace();
    let mut ctx = ctx_for(ws.path(), "workspace-write");
    ctx.working_dir = None;
    let cwd = std::env::current_dir().unwrap();
    assert!(
        matches!(check(&ctx, &cwd.join("file.txt")), GateOutcome::Allow),
        "a relative write lands in the process cwd, so that is the workspace"
    );
    assert!(matches!(
        check(&ctx, Path::new("/etc/passwd")),
        GateOutcome::Blocked { .. }
    ));
}

#[test]
fn workspace_write_is_enforced_through_the_context() {
    let ws = workspace();
    let ctx = ctx_for(ws.path(), "workspace-write");
    assert!(matches!(
        check(&ctx, Path::new("/etc/passwd")),
        GateOutcome::Blocked { .. }
    ));
    assert!(matches!(
        check(&ctx, &ws.path().join("inside.txt")),
        GateOutcome::Allow
    ));
}

// ─── the exceptions, and their parity with the bash sandbox ───────────────

#[test]
fn workspace_write_keeps_the_temp_directory_writable() {
    let ws = workspace();
    let roots = writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()));
    assert!(
        roots.contains(&std::env::temp_dir()),
        "parity with SandboxConfig::writable_paths: {roots:?}"
    );
    let boundary = Boundary::new(SandboxMode::WorkspaceWrite, ws.path().to_path_buf(), roots);
    assert!(is_allowed(&boundary, &std::env::temp_dir().join("t.txt")));
}

#[cfg(unix)]
#[test]
fn workspace_write_keeps_the_always_writable_devices_but_not_the_rest_of_dev() {
    let ws = workspace();
    let boundary = Boundary::new(
        SandboxMode::WorkspaceWrite,
        ws.path().to_path_buf(),
        writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path())),
    );
    assert!(is_allowed(&boundary, Path::new("/dev/null")));
    assert!(
        !is_allowed(&boundary, Path::new("/dev/sda")),
        "/dev as a whole must stay closed"
    );
}

#[test]
fn the_scratch_directory_is_writable_when_the_environment_names_one() {
    let _env = crate::storage::lock_test_env();
    let scratch = tempfile::tempdir().unwrap();
    let _guard = EnvVarGuard::set("ARTERM_SCRATCH_DIR", scratch.path());
    let ws = workspace();
    let roots = writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()));
    assert!(roots.contains(&scratch.path().to_path_buf()), "{roots:?}");
}

// ─── the refusal a user reads ─────────────────────────────────────────────

#[test]
fn the_refusal_names_the_path_the_mode_and_itself() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    let message = refusal_message(&boundary, Path::new("/etc/passwd"));
    assert!(message.contains("/etc/passwd"), "{message}");
    assert!(message.contains("workspace-write"), "{message}");
    assert!(
        message.contains("not a missing file"),
        "a blocked write must not read as a failed one: {message}"
    );
    assert!(
        message.contains(&ws.path().display().to_string()),
        "the refusal should say where writes are allowed: {message}"
    );
}

#[cfg(unix)]
#[test]
fn the_refusal_shows_where_a_symlink_actually_pointed() {
    let ws = workspace();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), &ws.path().join("escape"));
    let boundary = workspace_only(ws.path());
    let message = refusal_message(&boundary, &ws.path().join("escape/loot.txt"));
    assert!(message.contains("resolves to"), "{message}");
    assert!(
        message.contains(&outside.path().display().to_string()),
        "{message}"
    );
}

#[test]
fn the_read_only_refusal_says_which_mode_refused() {
    let ws = workspace();
    let boundary = Boundary::new(SandboxMode::Readonly, ws.path().to_path_buf(), Vec::new());
    let message = refusal_message(&boundary, &ws.path().join("inside.txt"));
    assert!(message.contains("read-only"), "{message}");
}

// ─── the tools themselves ─────────────────────────────────────────────────

fn ctx_for(working_dir: &Path, sandbox_mode: &str) -> ToolContext {
    ToolContext {
        session_id: "sandbox-boundary-tests".into(),
        message_id: "m".into(),
        tool_call_id: "t".into(),
        working_dir: Some(working_dir.to_path_buf()),
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: crate::tool::ToolExecutionMode::Direct,
        sandbox_mode: sandbox_mode.to_string(),
    }
}

struct EnvVarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &Path) -> Self {
        let previous = std::env::var_os(key);
        crate::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => crate::env::set_var(self.key, value),
            None => crate::env::remove_var(self.key),
        }
    }
}

/// A workspace, plus a writable location that is genuinely outside every
/// writable root -- including the temp exception, which is pointed at a third
/// directory for the duration.
struct Sandboxed {
    // Declaration order is drop order: the environment guards must restore
    // TMPDIR before `_env` releases the lock that made the change safe.
    _tmpdir: EnvVarGuard,
    _scratch: EnvVarGuard,
    _root: tempfile::TempDir,
    _env: std::sync::MutexGuard<'static, ()>,
    workspace: std::path::PathBuf,
    outside: std::path::PathBuf,
}

fn sandboxed_workspace() -> Sandboxed {
    let env = crate::storage::lock_test_env();
    let root = tempfile::tempdir().expect("root tempdir");
    let temp = root.path().join("temp");
    let workspace = root.path().join("workspace");
    let outside = root.path().join("outside");
    for dir in [&temp, &workspace, &outside] {
        std::fs::create_dir_all(dir).unwrap();
    }
    // `outside` lives under the real system temp dir, so the temp exception
    // has to be redirected or this test would pass for the wrong reason.
    let tmpdir = EnvVarGuard::set("TMPDIR", &temp);
    let scratch = EnvVarGuard::set("ARTERM_SCRATCH_DIR", &temp);
    Sandboxed {
        _tmpdir: tmpdir,
        _scratch: scratch,
        _root: root,
        _env: env,
        workspace,
        outside,
    }
}

#[tokio::test]
async fn write_tool_refuses_a_writable_path_outside_the_workspace() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("escaped.txt");
    let ctx = ctx_for(&sb.workspace, "workspace-write");

    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": target.display().to_string(), "content": "pwned"}),
            ctx.clone(),
        )
        .await
        .expect_err("the write tool must not write outside the workspace");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");
    assert!(
        !target.exists(),
        "the file was created anyway: the boundary is not enforced"
    );

    // Control: the same tool, the same session, a path inside the workspace.
    let inside = sb.workspace.join("ok.txt");
    crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": inside.display().to_string(), "content": "fine"}),
            ctx,
        )
        .await
        .expect("a write inside the workspace must still work");
    assert_eq!(std::fs::read_to_string(&inside).unwrap(), "fine");
}

#[tokio::test]
async fn write_tool_refuses_a_parent_walk_out_of_the_workspace() {
    let sb = sandboxed_workspace();
    let ctx = ctx_for(&sb.workspace, "workspace-write");
    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": "../outside/relative.txt", "content": "pwned"}),
            ctx,
        )
        .await
        .expect_err("`..` must not walk out of the workspace");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");
    assert!(!sb.outside.join("relative.txt").exists());
}

#[tokio::test]
async fn edit_tool_refuses_a_file_outside_the_workspace() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("victim.txt");
    std::fs::write(&target, "original").unwrap();
    let ctx = ctx_for(&sb.workspace, "workspace-write");

    let err = crate::tool::edit::EditTool::new()
        .execute(
            serde_json::json!({
                "file_path": target.display().to_string(),
                "old_string": "original",
                "new_string": "tampered",
            }),
            ctx,
        )
        .await
        .expect_err("the edit tool must not edit outside the workspace");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
}

#[tokio::test]
async fn multiedit_tool_refuses_a_file_outside_the_workspace() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("victim.txt");
    std::fs::write(&target, "original").unwrap();
    let ctx = ctx_for(&sb.workspace, "workspace-write");

    let err = crate::tool::multiedit::MultiEditTool::new()
        .execute(
            serde_json::json!({
                "file_path": target.display().to_string(),
                "edits": [{"old_string": "original", "new_string": "tampered"}],
            }),
            ctx,
        )
        .await
        .expect_err("the multiedit tool must not edit outside the workspace");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
}

#[tokio::test]
async fn apply_patch_refuses_to_add_or_delete_outside_the_workspace() {
    let sb = sandboxed_workspace();
    let added = sb.outside.join("added.txt");
    let deleted = sb.outside.join("deleted.txt");
    std::fs::write(&deleted, "keep me").unwrap();
    let ctx = ctx_for(&sb.workspace, "workspace-write");

    let patch = format!(
        "*** Begin Patch\n*** Add File: {}\n+pwned\n*** Delete File: {}\n*** End Patch",
        added.display(),
        deleted.display()
    );
    let output = crate::tool::apply_patch::ApplyPatchTool::new()
        .execute(serde_json::json!({"patch_text": patch}), ctx)
        .await
        .expect("apply_patch reports per-file failures rather than erroring");
    assert!(output.output.contains("sandbox_mode"), "{}", output.output);
    assert!(!added.exists(), "add hunk escaped the workspace");
    assert_eq!(
        std::fs::read_to_string(&deleted).unwrap(),
        "keep me",
        "delete hunk escaped the workspace"
    );
}

#[tokio::test]
async fn patch_tool_refuses_a_file_outside_the_workspace() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("victim.txt");
    std::fs::write(&target, "original\n").unwrap();
    let ctx = ctx_for(&sb.workspace, "workspace-write");

    let patch = format!(
        "--- {}\n+++ {}\n@@ -1 +1 @@\n-original\n+tampered\n",
        target.display(),
        target.display()
    );
    let output = crate::tool::patch::PatchTool::new()
        .execute(serde_json::json!({"patch_text": patch}), ctx)
        .await
        .expect("the patch tool reports per-file failures rather than erroring");
    assert!(output.output.contains("sandbox_mode"), "{}", output.output);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original\n");
}

#[tokio::test]
async fn read_only_refuses_a_write_inside_the_workspace() {
    let sb = sandboxed_workspace();
    let target = sb.workspace.join("inside.txt");
    let ctx = ctx_for(&sb.workspace, "read-only");

    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": target.display().to_string(), "content": "nope"}),
            ctx,
        )
        .await
        .expect_err("read-only must refuse every write");
    assert!(err.to_string().contains("read-only"), "{err}");
    assert!(!target.exists());
}

#[tokio::test]
async fn full_access_still_writes_anywhere() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("allowed.txt");
    let ctx = ctx_for(&sb.workspace, "full-access");

    crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": target.display().to_string(), "content": "fine"}),
            ctx,
        )
        .await
        .expect("full-access is the documented escape hatch");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "fine");
}

#[tokio::test]
async fn undo_is_refused_in_read_only_and_keeps_its_checkpoint() {
    let sb = sandboxed_workspace();
    let file = sb.workspace.join("undoable.txt");
    std::fs::write(&file, "before").unwrap();
    let ctx = ctx_for(&sb.workspace, "read-only");
    crate::tool::checkpoint::GLOBAL.snapshot_and_record(&ctx.session_id, &file);
    std::fs::write(&file, "after").unwrap();
    let checkpoints = crate::tool::checkpoint::GLOBAL.len();

    let err = crate::tool::undo::UndoTool::new()
        .execute(
            serde_json::json!({"file_path": file.display().to_string()}),
            ctx,
        )
        .await
        .expect_err("restoring a file is a modification, which read-only refuses");
    assert!(err.to_string().contains("read-only"), "{err}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
    assert_eq!(
        crate::tool::checkpoint::GLOBAL.len(),
        checkpoints,
        "a refused undo must not consume the checkpoint it refused to apply"
    );
}

#[tokio::test]
async fn a_refused_write_records_no_undo_checkpoint() {
    let sb = sandboxed_workspace();
    let target = sb.outside.join("escaped.txt");
    let ctx = ctx_for(&sb.workspace, "workspace-write");
    let before = crate::tool::checkpoint::GLOBAL.len();

    let _ = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": target.display().to_string(), "content": "pwned"}),
            ctx,
        )
        .await;

    assert_eq!(
        crate::tool::checkpoint::GLOBAL.len(),
        before,
        "a refused write must leave no trace, not a checkpoint for a file it never touched"
    );
}
