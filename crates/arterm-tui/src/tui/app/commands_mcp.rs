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

use crate::tui::mcp_picker::{McpPicker, McpPickerOutcome, McpServerRow, McpServerState};

use super::{App, DisplayMessage};

pub(super) fn handle_mcp_command(app: &mut App, trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("/mcp") else {
        return false;
    };
    // Only claim the exact command, never `/mcpsomething`.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return false;
    }
    match rest.trim() {
        // The interactive overlay: list -> per-server detail -> actions.
        "" => {
            app.open_mcp_picker();
            true
        }
        // The transcript card: colored one-shot status snapshot.
        "status" => {
            let report = build_mcp_report(&app.mcp_server_names, &app.mcp_not_connected);
            app.push_display_message(DisplayMessage::mcp(report).with_title("MCP servers"));
            true
        }
        _ => {
            app.push_display_message(DisplayMessage::error(
                "Usage: /mcp (interactive) or /mcp status (transcript card). Manage servers \
                 with `arterm mcp add/list/remove` in a terminal."
                    .to_string(),
            ));
            true
        }
    }
}

impl App {
    /// Open the `/mcp` overlay from the current status cache + on-disk config.
    pub(in crate::tui) fn open_mcp_picker(&mut self) {
        let rows = self.build_mcp_server_rows();
        self.mcp_picker_overlay = Some(McpPicker::new(rows));
        self.request_full_redraw();
    }

    /// Feed one key to the `/mcp` overlay. Returns an action the caller must
    /// route (remote: `Request::McpAction`; local: see
    /// [`Self::handle_mcp_picker_action_local`]), closing the overlay when it
    /// asks for that instead.
    pub(in crate::tui) fn handle_mcp_picker_key_outcome(
        &mut self,
        code: crossterm::event::KeyCode,
        modifiers: crossterm::event::KeyModifiers,
    ) -> Option<(&'static str, Option<String>)> {
        let picker = self.mcp_picker_overlay.as_mut()?;
        let outcome = picker.handle_key(code, modifiers);
        self.request_full_redraw();
        match outcome {
            McpPickerOutcome::Stay => None,
            McpPickerOutcome::Close => {
                self.mcp_picker_overlay = None;
                None
            }
            McpPickerOutcome::Action { action, server } => Some((action, server)),
        }
    }

    /// Local sessions own their MCP manager but the overlay's actions run
    /// through the async server path; until that is wired for local mode, be
    /// honest about it in the footer instead of silently doing nothing.
    pub(in crate::tui) fn handle_mcp_picker_action_local(
        &mut self,
        action: &str,
        _server: Option<String>,
    ) {
        if let Some(picker) = self.mcp_picker_overlay.as_mut() {
            picker.set_status(format!(
                "'{}' is not wired for local sessions yet — ask the model to use the mcp tool.",
                action
            ));
        }
        self.request_full_redraw();
    }

    /// Snapshot every configured/connected server for the overlay.
    pub(in crate::tui) fn build_mcp_server_rows(&self) -> Vec<McpServerRow> {
        let project_dir = self
            .session
            .working_dir
            .as_ref()
            .map(std::path::PathBuf::from);
        let config = crate::mcp::McpConfig::load_for_dir(project_dir.as_deref());
        let sources = crate::mcp::attribute_server_sources(project_dir.as_deref());

        // "name" or "name — reason" entries from the server's connect pass.
        let failure_reasons: std::collections::HashMap<&str, Option<&str>> = self
            .mcp_not_connected
            .iter()
            .map(|entry| match entry.split_once(" — ") {
                Some((name, reason)) => (name, Some(reason)),
                None => (entry.as_str(), None),
            })
            .collect();
        // Local sessions cache full tool names at init; remote sessions fetch
        // on demand through the overlay.
        let mut local_tools: std::collections::HashMap<&str, Vec<String>> =
            std::collections::HashMap::new();
        for (server, tool) in &self.mcp_tool_names {
            local_tools
                .entry(server.as_str())
                .or_default()
                .push(tool.clone());
        }

        let mut names: Vec<String> = config.servers.keys().cloned().collect();
        for (name, _) in &self.mcp_server_names {
            // Ad-hoc connected servers may not exist in any config file.
            if !config.servers.contains_key(name) {
                names.push(name.clone());
            }
        }
        names.sort();
        names.dedup();

        names
            .into_iter()
            .map(|name| {
                let cfg = config.servers.get(&name);
                let live = self
                    .mcp_server_names
                    .iter()
                    .find(|(live_name, _)| live_name == &name)
                    .map(|(_, count)| *count);
                let state = match live {
                    Some(0) => McpServerState::Connecting,
                    Some(tool_count) => McpServerState::Connected { tool_count },
                    None if cfg.is_some_and(|cfg| !cfg.is_enabled()) => McpServerState::Disabled,
                    None => McpServerState::NotConnected {
                        reason: failure_reasons
                            .get(name.as_str())
                            .and_then(|reason| reason.map(str::to_string)),
                    },
                };
                let tools = local_tools.get(name.as_str()).map(|tools| {
                    let mut tools = tools.clone();
                    tools.sort();
                    tools
                });
                McpServerRow {
                    state,
                    command: cfg.map(|cfg| cfg.command.clone()).unwrap_or_default(),
                    args: cfg.map(|cfg| cfg.args.clone()).unwrap_or_default(),
                    source: sources
                        .get(&name)
                        .copied()
                        .unwrap_or(crate::mcp::McpServerSource::Imported),
                    shared: cfg.is_none_or(|cfg| cfg.shared),
                    tools,
                    name,
                }
            })
            .collect()
    }

    /// Refresh the open `/mcp` overlay after an `McpStatus` event.
    pub(in crate::tui) fn refresh_mcp_picker(&mut self) {
        if self.mcp_picker_overlay.is_some() {
            let rows = self.build_mcp_server_rows();
            if let Some(picker) = self.mcp_picker_overlay.as_mut() {
                picker.set_rows(rows);
            }
            self.request_full_redraw();
        }
    }
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
