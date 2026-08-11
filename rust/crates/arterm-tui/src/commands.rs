//! Slash command system for the TUI.
//!
//! Parses user input that starts with `/` (or the `?` shortcut) into typed
//! [`Command`] values, and provides the help-panel text rendered by the draw
//! routine when the help overlay is active.

/// A parsed slash command.
///
/// Produced by [`parse_command`] from raw user input. Each variant corresponds
/// to one entry in the help panel ([`help_text`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// `/help` or `?` — show the help panel overlay.
    Help,
    /// `/clear` — reset the conversation transcript.
    Clear,
    /// `/model [name]` — switch the active model.
    ///
    /// The payload is the requested model name, or an empty string when the
    /// user typed `/model` with no argument (in which case the caller may show
    /// the current model or list available models).
    Model(String),
    /// `/exit` (or `/quit`) — quit the application.
    Exit,
    /// `/compact` — shrink context.
    Compact,
    /// `/mode [mode]` — set the permission mode (`ask`, `auto`, or `yolo`).
    Mode(String),
    /// `/copy` — copy the last assistant reply to the clipboard.
    Copy,
    /// `/version` — print the Arterm version.
    Version,
}

/// Parse a raw input line into a [`Command`].
///
/// Returns `None` when the input is not a recognised command. The input is
/// trimmed and matched case-insensitively on the command keyword. Arguments
/// (everything after the first whitespace-separated token) are passed through
/// verbatim to the variants that take a payload ([`Command::Model`],
/// [`Command::Mode`]).
///
/// The bare `?` character is treated as a shortcut for `/help`.
pub fn parse_command(input: &str) -> Option<Command> {
    let trimmed = input.trim();

    // `?` (alone or with trailing whitespace) is the help shortcut.
    if trimmed == "?" {
        return Some(Command::Help);
    }

    // Only inputs starting with `/` are commands.
    let rest = trimmed.strip_prefix('/')?;

    // Split into the command keyword and the remaining argument string.
    let (keyword, arg) = match rest.split_once(char::is_whitespace) {
        Some((k, a)) => (k, a.trim()),
        None => (rest, ""),
    };

    match keyword.to_ascii_lowercase().as_str() {
        "help" | "h" => Some(Command::Help),
        "clear" => Some(Command::Clear),
        "model" | "m" => Some(Command::Model(arg.to_string())),
        "exit" | "quit" | "q" => Some(Command::Exit),
        "compact" => Some(Command::Compact),
        "mode" => Some(Command::Mode(arg.to_string())),
        "copy" => Some(Command::Copy),
        "version" | "v" => Some(Command::Version),
        _ => None,
    }
}

/// Return the help-panel content as a list of lines.
///
/// The lines are grouped jcode-style. Each entry is a plain `String` (no
/// ANSI styling); the draw routine applies colour/bold when rendering.
pub fn help_text() -> Vec<String> {
    let mut lines = Vec::new();

    // Header.
    lines.push("Arterm — Slash Commands".to_string());
    lines.push(String::new()); // blank separator

    // ── Chat & models ──────────────────────────────────────────────────
    lines.push("Chat & models:".to_string());
    lines.push("  /help or ?      Show this help".to_string());
    lines.push("  /model [name]   Switch model".to_string());
    lines.push("  /clear          Reset conversation".to_string());
    lines.push("  /compact        Shrink context".to_string());
    lines.push("  /copy [all]     Copy last reply or all".to_string());
    lines.push("  /mode [mode]    Set permission mode: ask|auto|yolo".to_string());
    lines.push("  /version        Show version".to_string());
    lines.push("  /exit           Quit (or Ctrl+C twice)".to_string());

    lines.push(String::new()); // blank separator

    // ── Tips ───────────────────────────────────────────────────────────
    lines.push("Tips:".to_string());
    lines.push("  ↑ / ↓           Scroll transcript".to_string());
    lines.push("  PgUp / PgDn     Fast scroll".to_string());
    lines.push("  Drag select     Copy selected text".to_string());

    lines
}
