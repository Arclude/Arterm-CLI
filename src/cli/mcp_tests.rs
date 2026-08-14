//! Tests for `arterm mcp add/list/remove`.
//!
//! Every test isolates ARTERM_HOME, HOME, and the working directory in a
//! tempdir under the env lock: `McpConfig::load` reads the developer's real
//! `~/.arterm/mcp.json` and `~/.claude.json` otherwise, and `add --scope
//! project` writes relative to cwd.

use super::*;
use crate::mcp::McpConfig;
use std::path::Path;

struct IsolatedEnv {
    _lock: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    previous_cwd: std::path::PathBuf,
}

impl IsolatedEnv {
    fn new() -> Self {
        let lock = crate::storage::lock_test_env();
        let temp = tempfile::TempDir::new().expect("create temp dir");
        let saved = ["ARTERM_HOME", "HOME", "XDG_CONFIG_HOME"]
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        let previous_cwd = std::env::current_dir().expect("read cwd");

        let arterm_home = temp.path().join("arterm-home");
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        for dir in [&arterm_home, &home, &project] {
            std::fs::create_dir_all(dir).expect("create temp dirs");
        }
        crate::env::set_var("ARTERM_HOME", &arterm_home);
        crate::env::set_var("HOME", &home);
        crate::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
        std::env::set_current_dir(&project).expect("enter temp project");

        Self {
            _lock: lock,
            _temp: temp,
            saved,
            previous_cwd,
        }
    }

    fn user_mcp_json(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("ARTERM_HOME").expect("isolated ARTERM_HOME"))
            .join("mcp.json")
    }
}

impl Drop for IsolatedEnv {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.previous_cwd);
        for (key, value) in self.saved.drain(..) {
            match value {
                Some(value) => crate::env::set_var(key, value),
                None => crate::env::remove_var(key),
            }
        }
    }
}

fn add_demo_server(scope: McpScopeArg) {
    run_add(
        "demo".to_string(),
        vec!["DEMO_SECRET=shh".to_string()],
        scope,
        false,
        vec![
            "python3".to_string(),
            "/srv/server.py".to_string(),
            "--utc".to_string(),
        ],
    )
    .expect("add server");
}

fn row_for<'a>(rows: &'a [ListRow], name: &str) -> &'a ListRow {
    rows.iter()
        .find(|row| row.name == name)
        .unwrap_or_else(|| panic!("no list row for '{}'", name))
}

#[test]
fn the_add_command_writes_the_user_file_and_list_attributes_it() {
    let env = IsolatedEnv::new();
    add_demo_server(McpScopeArg::User);

    let written = McpConfig::load_from_file(&env.user_mcp_json()).expect("parse written file");
    let cfg = written.servers.get("demo").expect("demo server present");
    assert_eq!(cfg.command, "python3");
    assert_eq!(cfg.args, vec!["/srv/server.py", "--utc"]);
    assert_eq!(cfg.env.get("DEMO_SECRET").map(String::as_str), Some("shh"));
    assert!(cfg.shared);

    let rows = list_rows();
    let row = row_for(&rows, "demo");
    assert_eq!(row.source, "user (~/.arterm/mcp.json)");
    assert_eq!(row.command, "python3");
    // Env values must never leak into list output; only key names appear.
    assert_eq!(row.env_keys, vec!["DEMO_SECRET"]);
    assert!(
        !serde_json::to_string(row)
            .expect("serialize row")
            .contains("shh")
    );
}

#[test]
fn the_project_scope_writes_the_local_file_and_remove_finds_it_unscoped() {
    let _env = IsolatedEnv::new();
    add_demo_server(McpScopeArg::Project);

    let local = Path::new(".arterm/mcp.json");
    assert!(
        local.exists(),
        "project-scope add must write .arterm/mcp.json"
    );
    let rows = list_rows();
    assert_eq!(row_for(&rows, "demo").source, "project (.arterm/mcp.json)");

    run_remove("demo".to_string(), None).expect("unscoped remove searches project scope");
    let after = McpConfig::load_from_file(local).expect("parse after remove");
    assert!(after.servers.is_empty());
}

#[test]
fn a_replacing_add_and_a_scoped_remove_round_trip_the_user_file() {
    let env = IsolatedEnv::new();
    add_demo_server(McpScopeArg::User);
    run_add(
        "demo".to_string(),
        vec![],
        McpScopeArg::User,
        true,
        vec!["deno".to_string()],
    )
    .expect("replace server");

    let written = McpConfig::load_from_file(&env.user_mcp_json()).expect("parse written file");
    let cfg = written.servers.get("demo").expect("demo server present");
    assert_eq!(cfg.command, "deno", "add must replace, not merge");
    assert!(!cfg.shared, "--no-share must persist");

    run_remove("demo".to_string(), Some(McpScopeArg::User)).expect("scoped remove");
    let after = McpConfig::load_from_file(&env.user_mcp_json()).expect("parse after remove");
    assert!(after.servers.is_empty());
}

#[test]
fn removing_an_unknown_or_imported_server_explains_itself() {
    let _env = IsolatedEnv::new();

    let missing = run_remove("ghost".to_string(), None).expect_err("unknown name must fail");
    assert!(missing.to_string().contains("no MCP server named 'ghost'"));

    // A server defined only in `.mcp.json` (a Claude Code project file) is
    // visible in the merged view but not editable by `arterm mcp`.
    std::fs::write(
        ".mcp.json",
        r#"{"servers": {"imported": {"command": "bun"}}}"#,
    )
    .expect("write .mcp.json");
    let rows = list_rows();
    assert_eq!(row_for(&rows, "imported").source, IMPORTED_SOURCE);
    let imported = run_remove("imported".to_string(), None).expect_err("imported must not vanish");
    assert!(
        imported.to_string().contains("imported config"),
        "error must say where the server comes from: {}",
        imported
    );
}

#[test]
fn env_pairs_require_a_key_and_an_equals_sign() {
    assert!(parse_env_pairs(&["NO_EQUALS".to_string()]).is_err());
    assert!(parse_env_pairs(&["=value".to_string()]).is_err());
    let parsed = parse_env_pairs(&["A=1".to_string(), "B=x=y".to_string()]).expect("valid pairs");
    assert_eq!(parsed.get("A").map(String::as_str), Some("1"));
    assert_eq!(
        parsed.get("B").map(String::as_str),
        Some("x=y"),
        "values may themselves contain '='"
    );
}
