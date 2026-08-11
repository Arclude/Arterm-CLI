//! Permission system for tool execution, mirroring the TS Arterm's
//! ask / auto / yolo modes.
//!
//! - **Ask**  — the agent asks the user before every non-read tool call.
//! - **Auto** — the agent runs tools automatically, but may still ask for
//!   dangerous ones (not yet wired up).
//! - **Yolo** — no checks at all, everything runs.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::Permission;

/// Which permission mode the agent is operating in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    /// Ask the user before every potentially-dangerous tool call.
    #[default]
    Ask,
    /// Run tools automatically; ask only for explicitly-denied or dangerous ones.
    Auto,
    /// Run everything without asking. Danger zone.
    Yolo,
}

impl PermissionMode {
    /// A short human-readable label for display in the TUI.
    pub fn label(&self) -> &'static str {
        match self {
            PermissionMode::Ask => "ask",
            PermissionMode::Auto => "auto",
            PermissionMode::Yolo => "yolo",
        }
    }
}

/// The outcome of a permission check for a single tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionVerdict {
    /// The tool may run immediately.
    Allow,
    /// The tool must not run. The caller should record an error result.
    Deny,
    /// The caller should prompt the user with the given message and wait for a
    /// decision before proceeding.
    Ask(String),
}

/// Manages permission decisions for tool execution.
///
/// Holds the active [`PermissionMode`] plus per-tool allow/deny lists that let
/// the user pre-approve or pre-reject specific tools regardless of mode.
#[derive(Debug, Clone)]
pub struct PermissionManager {
    /// The active permission mode.
    pub mode: PermissionMode,
    /// Tool names the user has explicitly approved (always allowed).
    allowed_tools: HashSet<String>,
    /// Tool names the user has explicitly rejected (always denied).
    denied_tools: HashSet<String>,
}

impl Default for PermissionManager {
    fn default() -> Self {
        Self::new(PermissionMode::Ask)
    }
}

impl PermissionManager {
    /// Create a new manager in the given mode with empty allow/deny lists.
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            allowed_tools: HashSet::new(),
            denied_tools: HashSet::new(),
        }
    }

    /// Permanently allow a tool (overrides mode-based asking).
    pub fn allow(&mut self, tool_name: impl Into<String>) {
        let name = tool_name.into();
        self.denied_tools.remove(&name);
        self.allowed_tools.insert(name);
    }

    /// Permanently deny a tool (overrides mode-based allowing).
    pub fn deny(&mut self, tool_name: impl Into<String>) {
        let name = tool_name.into();
        self.allowed_tools.remove(&name);
        self.denied_tools.insert(name);
    }

    /// All currently-allowed tool names.
    pub fn allowed_tools(&self) -> &HashSet<String> {
        &self.allowed_tools
    }

    /// All currently-denied tool names.
    pub fn denied_tools(&self) -> &HashSet<String> {
        &self.denied_tools
    }

    /// Decide whether a tool call should run.
    ///
    /// Evaluation order:
    /// 1. Explicit deny list → [`PermissionVerdict::Deny`].
    /// 2. Explicit allow list → [`PermissionVerdict::Allow`].
    /// 3. Mode-based default (see [`Self::mode_default`]).
    pub fn check(&self, tool_name: &str, permission: Permission) -> PermissionVerdict {
        // 1. Explicit deny always wins.
        if self.denied_tools.contains(tool_name) {
            return PermissionVerdict::Deny;
        }

        // 2. Explicit allow always wins.
        if self.allowed_tools.contains(tool_name) {
            return PermissionVerdict::Allow;
        }

        // 3. Fall back to the mode-based default.
        self.mode_default(tool_name, permission)
    }

    /// The verdict implied purely by the active mode, ignoring the allow/deny
    /// lists.
    ///
    /// - Read tools are always allowed (they are side-effect free).
    /// - Write tools: allowed in Auto/Yolo, denied in Ask (with a TODO for
    ///   interactive prompting).
    fn mode_default(&self, _tool_name: &str, permission: Permission) -> PermissionVerdict {
        match permission {
            // Reads are safe in every mode.
            Permission::Read => PermissionVerdict::Allow,
            // Writes depend on the mode.
            Permission::Write => match self.mode {
                PermissionMode::Yolo | PermissionMode::Auto => PermissionVerdict::Allow,
                // TODO: emit a real interactive prompt and let the user
                // approve/deny. For now we deny so nothing dangerous runs
                // silently in Ask mode.
                PermissionMode::Ask => PermissionVerdict::Deny,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_always_allowed() {
        for &mode in &[PermissionMode::Ask, PermissionMode::Auto, PermissionMode::Yolo] {
            let pm = PermissionManager::new(mode);
            assert_eq!(pm.check("read", Permission::Read), PermissionVerdict::Allow);
        }
    }

    #[test]
    fn writes_denied_in_ask_mode_by_default() {
        let pm = PermissionManager::new(PermissionMode::Ask);
        assert_eq!(pm.check("bash", Permission::Write), PermissionVerdict::Deny);
    }

    #[test]
    fn writes_allowed_in_auto_and_yolo() {
        for &mode in &[PermissionMode::Auto, PermissionMode::Yolo] {
            let pm = PermissionManager::new(mode);
            assert_eq!(pm.check("bash", Permission::Write), PermissionVerdict::Allow);
        }
    }

    #[test]
    fn explicit_allow_overrides_mode() {
        let mut pm = PermissionManager::new(PermissionMode::Ask);
        pm.allow("bash");
        assert_eq!(pm.check("bash", Permission::Write), PermissionVerdict::Allow);
    }

    #[test]
    fn explicit_deny_overrides_everything() {
        let mut pm = PermissionManager::new(PermissionMode::Yolo);
        pm.deny("bash");
        assert_eq!(pm.check("bash", Permission::Write), PermissionVerdict::Deny);
    }

    #[test]
    fn deny_then_allow_clears_deny() {
        let mut pm = PermissionManager::new(PermissionMode::Yolo);
        pm.deny("bash");
        pm.allow("bash");
        assert_eq!(pm.check("bash", Permission::Write), PermissionVerdict::Allow);
    }

    #[test]
    fn default_mode_is_ask() {
        let pm = PermissionManager::default();
        assert_eq!(pm.mode, PermissionMode::Ask);
    }

    #[test]
    fn mode_label() {
        assert_eq!(PermissionMode::Ask.label(), "ask");
        assert_eq!(PermissionMode::Auto.label(), "auto");
        assert_eq!(PermissionMode::Yolo.label(), "yolo");
    }
}
