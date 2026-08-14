//! `/mcp`: colored status panel of MCP server state for this session.
//!
//! The live half comes from `app.mcp_server_names`, which both session kinds
//! keep current (the local lifecycle fills it after connecting; remote clients
//! receive `ServerEvent::McpStatus`). The configured half re-reads the merged
//! config from disk, so an entry added with `arterm mcp add` in another
//! terminal shows up here immediately — marked as needing a reload rather
//! than pretending it is already live. When the session actually attempted a
//! connect and failed, `app.mcp_not_connected` carries the error and the
//! panel shows it instead of the generic reload hint.
//!
//! Rendered through the dedicated `mcp` display role: its renderer colors
//! lines by prefix (`+` connected/green, `~` connecting/yellow, `!` not
//! connected/red, plain dim). The previous single-color system message made
//! connected and not-connected indistinguishable at a glance.

use super::{App, DisplayMessage};

pub(super) fn handle_mcp_command(app: &mut App, trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("/mcp") else {
        return false;
    };
    // Only claim the exact command, never `/mcpsomething`.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return false;
    }
    if !rest.trim().is_empty() {
        app.push_display_message(DisplayMessage::error(
            "Usage: /mcp (manage servers with `arterm mcp add/list/remove` in a terminal)"
                .to_string(),
        ));
        return true;
    }

    let report = build_mcp_report(&app.mcp_server_names, &app.mcp_not_connected);
    app.push_display_message(DisplayMessage::mcp(report).with_title("MCP servers"));
    true
}

fn build_mcp_report(live: &[(String, usize)], not_connected: &[String]) -> String {
    let configured = crate::mcp::McpConfig::load();

    let mut lines: Vec<String> = Vec::new();

    if live.is_empty() {
        lines.push("Connected in this session: none".to_string());
    } else {
        let mut live_sorted: Vec<&(String, usize)> = live.iter().collect();
        live_sorted.sort_by(|a, b| a.0.cmp(&b.0));
        lines.push(format!(
            "Connected in this session ({}):",
            live_sorted.len()
        ));
        for (name, tool_count) in live_sorted {
            match tool_count {
                0 => lines.push(format!("~ {} — connecting...", name)),
                1 => lines.push(format!("+ {} — connected · 1 tool", name)),
                n => lines.push(format!("+ {} — connected · {} tools", name, n)),
            }
        }
    }

    // Connect failures the server reported for this session, by name.
    // Entries arrive as "name" or "name — reason".
    let failure_reasons: std::collections::HashMap<&str, &str> = not_connected
        .iter()
        .map(|entry| match entry.split_once(" — ") {
            Some((name, reason)) => (name, reason),
            None => (entry.as_str(), ""),
        })
        .collect();

    let mut pending: Vec<(&String, bool)> = configured
        .servers
        .iter()
        .filter(|(name, _)| !live.iter().any(|(live_name, _)| live_name == *name))
        .map(|(name, cfg)| (name, cfg.is_enabled()))
        .collect();
    pending.sort();
    if !pending.is_empty() {
        lines.push(String::new());
        lines.push("Configured but not connected here:".to_string());
        for (name, enabled) in pending {
            if !enabled {
                lines.push(format!("  {} — disabled in config", name));
            } else {
                match failure_reasons.get(name.as_str()) {
                    Some(reason) if !reason.is_empty() => {
                        lines.push(format!("! {} — {}", name, reason));
                    }
                    _ => lines.push(format!("! {} — needs a reload or a new session", name)),
                }
            }
        }
    }

    if live.is_empty() && configured.servers.is_empty() {
        lines.push(String::new());
        lines.push("Add one from a terminal:".to_string());
        lines.push("  arterm mcp add <name> <command> [args...]".to_string());
    } else {
        lines.push(String::new());
        lines.push("Tools appear to the model as mcp__<server>__<tool>.".to_string());
        lines.push(
            "Manage with `arterm mcp add/list/remove`; to (re)connect without \
             restarting, ask the model to use the mcp tool (action: reload)."
                .to_string(),
        );
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // build_mcp_report reads the merged on-disk config, so tests isolate
    // ARTERM_HOME/HOME the same way the CLI config tests do.
    struct IsolatedHome {
        _lock: std::sync::MutexGuard<'static, ()>,
        temp: tempfile::TempDir,
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        previous_cwd: std::path::PathBuf,
    }

    impl IsolatedHome {
        fn new() -> Self {
            let lock = crate::storage::lock_test_env();
            let temp = tempfile::TempDir::new().expect("create temp dir");
            let saved = ["ARTERM_HOME", "HOME", "XDG_CONFIG_HOME"]
                .into_iter()
                .map(|key| (key, std::env::var_os(key)))
                .collect();
            let previous_cwd = std::env::current_dir().expect("read cwd");
            let project = temp.path().join("project");
            std::fs::create_dir_all(&project).expect("create project dir");
            crate::env::set_var("ARTERM_HOME", temp.path().join("arterm-home"));
            crate::env::set_var("HOME", temp.path().join("home"));
            crate::env::set_var("XDG_CONFIG_HOME", temp.path().join("home/.config"));
            std::env::set_current_dir(&project).expect("enter project dir");
            Self {
                _lock: lock,
                temp,
                saved,
                previous_cwd,
            }
        }

        fn write_user_config(&self, json: &str) {
            let dir = self.temp.path().join("arterm-home");
            std::fs::create_dir_all(&dir).expect("create arterm home");
            std::fs::write(dir.join("mcp.json"), json).expect("write mcp.json");
        }
    }

    impl Drop for IsolatedHome {
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

    #[test]
    fn the_report_separates_live_servers_from_configured_but_not_connected() {
        let env = IsolatedHome::new();
        env.write_user_config(
            r#"{"servers": {
                "pending": {"command": "python3"},
                "off": {"command": "python3", "enabled": false},
                "live": {"command": "python3"}
            }}"#,
        );

        let report = build_mcp_report(&[("live".to_string(), 3)], &[]);

        assert!(report.contains("+ live — connected · 3 tools"), "{report}");
        assert!(report.contains("! pending — needs a reload"), "{report}");
        assert!(report.contains("  off — disabled in config"), "{report}");
        assert!(
            !report.contains("! live"),
            "a connected server must not be listed as pending too: {report}"
        );
    }

    #[test]
    fn a_reported_connect_failure_replaces_the_generic_reload_hint() {
        let env = IsolatedHome::new();
        env.write_user_config(r#"{"servers": {"pending": {"command": "python3"}}}"#);

        let report = build_mcp_report(&[], &["pending — spawn failed: No such file".to_string()]);

        assert!(
            report.contains("! pending — spawn failed: No such file"),
            "{report}"
        );
        assert!(!report.contains("needs a reload"), "{report}");
    }

    #[test]
    fn an_empty_state_points_at_the_add_command() {
        let _env = IsolatedHome::new();
        let report = build_mcp_report(&[], &[]);
        assert!(
            report.contains("Connected in this session: none"),
            "{report}"
        );
        assert!(report.contains("arterm mcp add <name>"), "{report}");
    }

    #[test]
    fn a_zero_tool_count_reads_as_connecting() {
        let _env = IsolatedHome::new();
        let report = build_mcp_report(&[("warming".to_string(), 0)], &[]);
        assert!(report.contains("~ warming — connecting..."), "{report}");
    }
}
