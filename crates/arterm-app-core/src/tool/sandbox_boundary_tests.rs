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
use std::path::{Path, PathBuf};

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
        writable_roots(SandboxMode::Readonly, Some(ws.path()), &[]),
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
    let roots = writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()), &[]);
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
        writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()), &[]),
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
    let roots = writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()), &[]);
    assert!(roots.contains(&scratch.path().to_path_buf()), "{roots:?}");
}

// ─── the configured extra roots ───────────────────────────────────────────

#[test]
fn no_configured_roots_leaves_the_writable_set_exactly_as_it_was() {
    // The whole feature has to be invisible to everyone who does not use it.
    let ws = workspace();
    assert_eq!(
        writable_roots(SandboxMode::WorkspaceWrite, Some(ws.path()), &[]),
        writable_roots(
            SandboxMode::WorkspaceWrite,
            Some(ws.path()),
            &configured_roots_within(SandboxMode::WorkspaceWrite, ws.path(), &[]),
        ),
    );
}

#[test]
fn a_configured_root_joins_the_writable_set() {
    // `sandboxed_workspace` is what makes "outside" mean outside: the temp
    // exception is redirected, so a directory it did not name is genuinely
    // beyond every writable root.
    let sb = sandboxed_workspace();
    let granted = sb.outside.join("granted");
    let sibling = sb.outside.join("granted-evil");
    std::fs::create_dir_all(&granted).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();

    let roots = configured_roots_within(
        SandboxMode::WorkspaceWrite,
        &sb.workspace,
        &[granted.clone()],
    );
    assert_eq!(roots, vec![granted.clone()]);

    let boundary = Boundary::new(
        SandboxMode::WorkspaceWrite,
        sb.workspace.clone(),
        writable_roots(SandboxMode::WorkspaceWrite, Some(&sb.workspace), &roots),
    );
    assert!(is_allowed(&boundary, &granted.join("notes.md")));
    assert!(
        !is_allowed(&boundary, &sb.outside.join("notes.md")),
        "granting a directory must not grant its parent"
    );
    assert!(
        !is_allowed(&boundary, &sibling.join("notes.md")),
        "granting a directory must not grant its name-prefix siblings"
    );
}

#[test]
fn a_relative_configured_root_resolves_against_the_workspace() {
    // Not against the process cwd: the key lives in a global config file, so
    // the directory arterm happened to start in means nothing to it.
    let ws = workspace();
    let sub = ws.path().join("build-cache");
    std::fs::create_dir_all(&sub).unwrap();
    assert_eq!(
        configured_roots_within(
            SandboxMode::WorkspaceWrite,
            ws.path(),
            &[PathBuf::from("build-cache")],
        ),
        vec![sub],
    );
}

#[test]
fn a_configured_root_that_does_not_exist_grants_nothing() {
    // Landlock cannot name a directory it cannot open, so honouring a missing
    // root in-process would make `write` and `bash` disagree.
    let ws = workspace();
    assert!(
        configured_roots_within(
            SandboxMode::WorkspaceWrite,
            ws.path(),
            &[ws.path().join("typo"), PathBuf::from("/no/such/place")],
        )
        .is_empty()
    );
}

#[test]
fn a_configured_root_that_is_a_file_grants_nothing() {
    let ws = workspace();
    let file = ws.path().join("not-a-dir.txt");
    std::fs::write(&file, "").unwrap();
    assert!(configured_roots_within(SandboxMode::WorkspaceWrite, ws.path(), &[file]).is_empty());
}

#[test]
fn configured_roots_are_ignored_outside_workspace_write() {
    let ws = workspace();
    let extra = ws.path().to_path_buf();
    for mode in [SandboxMode::Readonly, SandboxMode::FullAccess] {
        assert!(
            configured_roots_within(mode, ws.path(), &[extra.clone()]).is_empty(),
            "{mode} must not gain writable roots from the config key"
        );
    }
}

#[test]
fn read_only_ignores_a_configured_root_through_the_context() {
    let sb = sandboxed_workspace();
    let granted = sb.outside.join("granted");
    std::fs::create_dir_all(&granted).unwrap();
    let ctx = ctx_with_roots(&sb.workspace, "read-only", vec![granted.clone()]);
    assert!(configured_roots(&ctx).is_empty());
    assert!(matches!(
        check(&ctx, &granted.join("file.txt")),
        GateOutcome::Blocked { .. }
    ));
}

#[test]
fn a_configured_root_is_enforced_through_the_context() {
    let sb = sandboxed_workspace();
    let granted = sb.outside.join("granted");
    std::fs::create_dir_all(&granted).unwrap();
    let target = granted.join("file.txt");

    assert!(
        matches!(
            check(&ctx_for(&sb.workspace, "workspace-write"), &target),
            GateOutcome::Blocked { .. }
        ),
        "without the config key this directory is outside the sandbox"
    );

    let widened = ctx_with_roots(&sb.workspace, "workspace-write", vec![granted]);
    assert!(matches!(check(&widened, &target), GateOutcome::Allow));
    assert!(
        matches!(
            check(&widened, &sb.outside.join("file.txt")),
            GateOutcome::Blocked { .. }
        ),
        "the grant is the named directory, not everything around it"
    );
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
fn the_refusal_offers_the_narrow_option_before_the_sledgehammer() {
    let ws = workspace();
    let boundary = workspace_only(ws.path());
    let message = refusal_message(&boundary, Path::new("/etc/passwd"));
    let narrow = message
        .find("sandbox_writable_roots")
        .expect("the refusal should name the one-directory option: {message}");
    let sledgehammer = message
        .find("full-access")
        .expect("the refusal should still mention the escape hatch");
    assert!(
        narrow < sledgehammer,
        "the narrow option should be offered first: {message}"
    );
}

#[test]
fn the_read_only_refusal_does_not_offer_a_key_that_does_nothing_there() {
    let ws = workspace();
    let boundary = Boundary::new(SandboxMode::Readonly, ws.path().to_path_buf(), Vec::new());
    let message = refusal_message(&boundary, &ws.path().join("inside.txt"));
    assert!(
        !message.contains("sandbox_writable_roots"),
        "read-only ignores the key, so suggesting it would send the reader in circles: {message}"
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
    ctx_with_roots(working_dir, sandbox_mode, Vec::new())
}

fn ctx_with_roots(
    working_dir: &Path,
    sandbox_mode: &str,
    sandbox_writable_roots: Vec<PathBuf>,
) -> ToolContext {
    ToolContext {
        session_id: "sandbox-boundary-tests".into(),
        message_id: "m".into(),
        tool_call_id: "t".into(),
        working_dir: Some(working_dir.to_path_buf()),
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: crate::tool::ToolExecutionMode::Direct,
        sandbox_mode: sandbox_mode.to_string(),
        sandbox_writable_roots,
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

/// The test this feature would most likely ship broken without: one directory,
/// two enforcement paths, and they have to answer the same.
///
/// `write` is checked in-process by `sandbox_boundary`; `bash` is checked by
/// the kernel, through a Landlock ruleset built in `bash.rs`. A wiring that
/// reached only one of them would still look green in every other test here.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn bash_and_write_agree_about_a_configured_root() {
    if arterm_sandbox::landlock_abi_version() == 0 {
        eprintln!("skipping: no Landlock on this kernel, so bash runs unsandboxed");
        return;
    }
    let sb = sandboxed_workspace();
    let granted = sb.outside.join("granted");
    std::fs::create_dir_all(&granted).unwrap();
    let ctx = ctx_with_roots(&sb.workspace, "workspace-write", vec![granted.clone()]);

    // In-process path.
    let from_write = granted.join("from-write.txt");
    crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": from_write.display().to_string(), "content": "ok"}),
            ctx.clone(),
        )
        .await
        .expect("the configured root must be writable through `write`");
    assert_eq!(std::fs::read_to_string(&from_write).unwrap(), "ok");

    // Subprocess path, same context, same directory.
    let from_bash = granted.join("from-bash.txt");
    let allowed = crate::tool::bash::BashTool::new()
        .execute(
            serde_json::json!({"command": format!("echo ok > {}", from_bash.display())}),
            ctx.clone(),
        )
        .await
        .expect("bash reports command failures in its output, not as an error");
    assert!(
        from_bash.exists(),
        "the configured root must be writable through `bash` too; bash said: {}",
        allowed.output
    );

    // And the grant stops at that directory in both paths.
    let refused = sb.outside.join("refused.txt");
    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": refused.display().to_string(), "content": "no"}),
            ctx.clone(),
        )
        .await
        .expect_err("one configured root must not widen its parent for `write`");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");

    let denied = crate::tool::bash::BashTool::new()
        .execute(
            serde_json::json!({"command": format!("echo no > {}", refused.display())}),
            ctx,
        )
        .await
        .expect("bash reports command failures in its output, not as an error");
    assert!(
        !refused.exists(),
        "one configured root must not widen its parent for `bash`: {}",
        denied.output
    );
}

#[tokio::test]
async fn write_tool_refuses_a_configured_root_that_does_not_exist() {
    // The directory is named in config but never created, so nothing is
    // granted -- rather than granting a path Landlock could never honour.
    let sb = sandboxed_workspace();
    let missing = sb.outside.join("never-created");
    let ctx = ctx_with_roots(&sb.workspace, "workspace-write", vec![missing.clone()]);

    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": missing.join("f.txt").display().to_string(),
                               "content": "no"}),
            ctx,
        )
        .await
        .expect_err("a configured root that does not exist grants nothing");
    assert!(err.to_string().contains("sandbox_mode"), "{err}");
    assert!(!missing.exists());
}

#[tokio::test]
async fn read_only_refuses_a_write_in_a_configured_root() {
    let sb = sandboxed_workspace();
    let granted = sb.outside.join("granted");
    std::fs::create_dir_all(&granted).unwrap();
    let target = granted.join("nope.txt");
    let ctx = ctx_with_roots(&sb.workspace, "read-only", vec![granted]);

    let err = crate::tool::write::WriteTool::new()
        .execute(
            serde_json::json!({"file_path": target.display().to_string(), "content": "nope"}),
            ctx,
        )
        .await
        .expect_err("read-only writes nothing anywhere, configured roots included");
    assert!(err.to_string().contains("read-only"), "{err}");
    assert!(!target.exists());
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

// ─── the constructor ──────────────────────────────────────────────────────

/// The one production path that fills a context's sandbox, driven end to end.
///
/// Every test above builds its own `ToolContext`, so all of them would still
/// pass if `tool_context` handed production a context with no sandbox in it --
/// which is the shape the original bug had: the tools learned the boundary
/// while the contexts reaching them stayed empty, and nothing observed the
/// difference. This one writes a real config file, reads it back through the
/// real cache, and checks what an actual call site receives.
/// A process that has read no config yet, with a home of its own.
///
/// Four tests below need the same three things -- an `ARTERM_HOME` nothing else
/// is using, an environment with no sandbox variables left over from another
/// test, and a process whose sandbox has not been frozen yet -- and all three
/// have to be put back afterwards or the next test inherits them. Restoring
/// happens in `Drop` so that it also happens when an assertion fails.
struct FreshProcess {
    home: tempfile::TempDir,
    prev_home: Option<std::ffi::OsString>,
    prev_mode: Option<std::ffi::OsString>,
    prev_floor: Option<std::ffi::OsString>,
}

impl FreshProcess {
    fn new() -> Self {
        let fresh = Self {
            home: tempfile::TempDir::new().expect("temp home"),
            prev_home: std::env::var_os("ARTERM_HOME"),
            prev_mode: std::env::var_os("ARTERM_SANDBOX_MODE"),
            prev_floor: std::env::var_os("ARTERM_SANDBOX_FLOOR"),
        };
        crate::env::set_var("ARTERM_HOME", fresh.home.path());
        // Both env settings outrank the config file, so leaving either in place
        // would mask what the file under test says.
        crate::env::remove_var("ARTERM_SANDBOX_MODE");
        crate::env::remove_var("ARTERM_SANDBOX_FLOOR");
        forget_resolved_sandbox_for_test();
        fresh
    }

    fn path(&self) -> &Path {
        self.home.path()
    }

    /// Write the config file this process reads, and make the next read see it.
    fn write_config(&self, body: &str) {
        std::fs::write(self.home.path().join("config.toml"), body).expect("write config");
        crate::config::Config::invalidate_cache();
    }

    fn set_floor(&self, floor: &str) {
        crate::env::set_var("ARTERM_SANDBOX_FLOOR", floor);
        forget_resolved_sandbox_for_test();
    }
}

impl Drop for FreshProcess {
    fn drop(&mut self) {
        restore("ARTERM_HOME", self.prev_home.take());
        restore("ARTERM_SANDBOX_MODE", self.prev_mode.take());
        restore("ARTERM_SANDBOX_FLOOR", self.prev_floor.take());
        crate::config::Config::invalidate_cache();
        forget_resolved_sandbox_for_test();
    }
}

fn restore(key: &str, previous: Option<std::ffi::OsString>) {
    match previous {
        Some(value) => crate::env::set_var(key, value),
        None => crate::env::remove_var(key),
    }
}

/// The mode a freshly built production context carries.
fn resolved_mode() -> String {
    tool_context(
        "session".to_string(),
        "message".to_string(),
        "call".to_string(),
        None,
        crate::tool::ToolExecutionMode::Direct,
    )
    .sandbox_mode
}

#[test]
fn a_production_context_takes_both_sandbox_fields_from_the_config_file() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    let configured_root = process.path().join("notes");
    std::fs::create_dir_all(&configured_root).expect("create the configured root");
    process.write_config(&format!(
        "sandbox_mode = \"workspace-write\"\nsandbox_writable_roots = [\"{}\"]\n",
        configured_root.display()
    ));
    let home = process.path().to_path_buf();

    let ctx = tool_context(
        "session".to_string(),
        "message".to_string(),
        "call".to_string(),
        Some(home.clone()),
        crate::tool::ToolExecutionMode::Direct,
    );

    assert_eq!(
        ctx.sandbox_mode, "workspace-write",
        "a context built for a tool call must carry the configured mode"
    );
    assert_eq!(
        ctx.sandbox_writable_roots,
        vec![configured_root.clone()],
        "the configured roots must ride along with the mode, not be left behind"
    );

    // ... and the boundary the tools consult agrees, so the two fields are not
    // merely present but wired to the thing that refuses a write.
    let boundary = Boundary::from_context(&ctx).expect("workspace-write is enforced");
    assert!(is_allowed(&boundary, &configured_root.join("scratch.txt")));
    assert!(!is_allowed(&boundary, Path::new("/etc/arterm-escape")));
}

/// The floor is the setting the setting cannot outrank.
///
/// `config.toml` is writable by the agent by design, so a mode that lives only
/// there is a lock whose key is inside the room. `ARTERM_SANDBOX_FLOOR` is read
/// from the launch environment, which a child process cannot reach into.
#[test]
fn a_floor_is_not_widened_by_the_config_file() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"full-access\"\n");
    process.set_floor("workspace-write");

    assert_eq!(
        resolved_mode(),
        "workspace-write",
        "a config file asking for full-access must not get past the floor"
    );
}

/// A floor is a floor, not a fixed value: asking for less is still allowed.
#[test]
fn a_config_file_may_still_be_stricter_than_the_floor() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"read-only\"\n");
    process.set_floor("workspace-write");

    assert_eq!(resolved_mode(), "read-only");
}

/// A typo in the floor must not be the difference between a sandbox and none.
///
/// Every other unparseable mode in this codebase fails open, deliberately and
/// with a test to say so. The floor is the one place that would be backwards:
/// it exists to be the value nobody can weaken, so a value nobody can read
/// becomes the strictest mode, which the operator notices on the first command.
#[test]
fn an_unparseable_floor_is_the_strictest_mode_rather_than_no_floor() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"full-access\"\n");
    process.set_floor("workspace-wirte");

    assert_eq!(resolved_mode(), "read-only");
}

/// Rewriting the config mid-session does not loosen the session doing it.
///
/// `config()` reloads from disk on a throttle, and the sandbox used to be read
/// from it on every single tool call -- so a session that wrote `full-access`
/// into its own config file ran the next command unsandboxed, seconds later,
/// without restarting. The sandbox is resolved once per process now.
#[test]
fn the_sandbox_does_not_loosen_when_the_config_file_changes() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"workspace-write\"\n");
    assert_eq!(resolved_mode(), "workspace-write");

    // Exactly what a session would do to free itself, config cache and all.
    process.write_config("sandbox_mode = \"full-access\"\n");

    assert_eq!(
        resolved_mode(),
        "workspace-write",
        "the mode this process started with is the mode it keeps"
    );
    assert_eq!(
        crate::config::config().sandbox_mode,
        "full-access",
        "the config file really did change -- the freeze is what held, not a stale read"
    );
}

/// The policy file is refused even when it sits inside a writable root.
///
/// A session whose working directory is the home directory has
/// `~/.arterm/config.toml` inside its own workspace, and every other check here
/// would allow it. This is the one deny that outranks a granted root.
#[test]
fn the_config_file_is_refused_even_inside_the_workspace() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"workspace-write\"\n");
    let home = process.path().to_path_buf();

    let ctx = tool_context(
        "session".to_string(),
        "message".to_string(),
        "call".to_string(),
        Some(home.clone()),
        crate::tool::ToolExecutionMode::Direct,
    );
    let boundary = Boundary::from_context(&ctx).expect("workspace-write is enforced");

    assert!(
        is_allowed(&boundary, &home.join("ordinary.txt")),
        "the workspace is still writable; only the policy file is not"
    );
    let message = refusal_message(&boundary, &home.join("config.toml"));
    assert!(
        message.contains("sandbox policy") || message.contains("sandbox"),
        "{message}"
    );
    assert!(
        message.contains("config.toml"),
        "the refusal should name the file it refused: {message}"
    );
}

/// Naming the policy file through a symlink is naming the policy file.
#[cfg(unix)]
#[test]
fn a_symlink_aimed_at_the_config_file_is_refused_too() {
    let _guard = crate::storage::lock_test_env();
    let process = FreshProcess::new();
    process.write_config("sandbox_mode = \"workspace-write\"\n");
    let home = process.path().to_path_buf();
    let disguise = home.join("just-a-file.txt");
    symlink(&home.join("config.toml"), &disguise);

    let ctx = tool_context(
        "session".to_string(),
        "message".to_string(),
        "call".to_string(),
        Some(home),
        crate::tool::ToolExecutionMode::Direct,
    );
    let boundary = Boundary::from_context(&ctx).expect("workspace-write is enforced");

    assert!(!is_allowed(&boundary, &disguise));
}
