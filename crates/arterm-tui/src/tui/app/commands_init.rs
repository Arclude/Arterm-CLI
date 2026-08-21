use super::commands_improve::{interrupt_and_queue_synthetic_message, start_synthetic_user_turn};
use super::{App, DisplayMessage};

/// `/init` generates or updates the project's `AGENTS.md` so later sessions
/// already know how the repo is laid out.
pub(super) fn parse_init_command(trimmed: &str) -> Option<Result<(), String>> {
    let rest = trimmed.strip_prefix("/init")?;
    // Only `/init` and `/init ` — never `/initiatives`.
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    if rest.trim().is_empty() {
        Some(Ok(()))
    } else {
        Some(Err("Usage: /init".to_string()))
    }
}

pub(super) fn build_init_prompt() -> String {
    "Create or update the project briefing file at `AGENTS.md` in the session working directory so later Arterm sessions understand this repo without being told again.

Arterm loads `AGENTS.md` into the system prompt at the start of every session. If `AGENTS.md` is missing, it will load `CLAUDE.md` instead. Write `AGENTS.md` (Arterm's native name). Do not create `CLAUDE.md`.

If `AGENTS.md` already exists, improve it in place. Do not overwrite working instructions with a generic template. Keep what is still true, fill gaps, drop stale or discoverable noise.

Explore the repo first (layout, README, build/test files, existing `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` / `.github/copilot-instructions.md` if present). Then write a short briefing a new agent can act on.

Include only facts that are not obvious from the tree:
- What this project is, in one or two sentences
- How to build, test, lint, and run
- Where the important code lives (packages, crates, entrypoints)
- Conventions that differ from language/tool defaults
- Pitfalls, non-obvious workflows, and 'never do X' rules

Keep it under ~200 lines. Use headings and bullets. No giant file trees, no dependency dumps, no architecture essays the code already states. Do not commit unless the user asks."
        .to_string()
}

pub(super) fn init_launch_notice(interrupted: bool) -> String {
    if interrupted {
        "👉 Interrupting and drafting AGENTS.md...".to_string()
    } else {
        "📝 Drafting AGENTS.md so later sessions know how this project works...".to_string()
    }
}

pub(super) fn handle_init_command_local(app: &mut App) {
    let prompt = build_init_prompt();
    if app.is_processing {
        interrupt_and_queue_synthetic_message(
            app,
            prompt,
            "Interrupting for /init...",
            init_launch_notice(true),
        );
    } else {
        app.push_display_message(DisplayMessage::system(init_launch_notice(false)));
        start_synthetic_user_turn(app, prompt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_init_accepts_bare_form() {
        assert_eq!(parse_init_command("/init"), Some(Ok(())));
        assert_eq!(parse_init_command("/init   "), Some(Ok(())));
    }

    #[test]
    fn parse_init_rejects_initiatives_and_other_commands() {
        assert_eq!(parse_init_command("/initiatives"), None);
        assert_eq!(parse_init_command("/improve"), None);
        assert_eq!(parse_init_command("init the project"), None);
    }

    #[test]
    fn parse_init_rejects_arguments() {
        assert_eq!(
            parse_init_command("/init please"),
            Some(Err("Usage: /init".to_string()))
        );
    }

    #[test]
    fn build_init_prompt_targets_agents_md() {
        let prompt = build_init_prompt();
        assert!(prompt.contains("`AGENTS.md`"));
        assert!(prompt.contains("Do not create `CLAUDE.md`"));
        assert!(prompt.contains("under ~200 lines"));
        assert!(prompt.contains("If `AGENTS.md` already exists, improve it in place"));
    }

    #[test]
    fn init_is_wired_on_local_and_remote_paths() {
        assert!(
            include_str!("commands.rs").contains("parse_init_command(trimmed)"),
            "local session dispatch does not handle /init"
        );
        assert!(
            include_str!("remote/key_handling.rs").contains("parse_init_command(trimmed)"),
            "remote key path does not handle /init"
        );
        assert!(
            include_str!("state_ui_input_helpers.rs").contains(r#""/init""#),
            "/init is not registered in the command palette"
        );
        assert!(
            include_str!("../ui_overlays.rs").contains(r#""/init""#),
            "/help does not list /init"
        );
        assert!(
            include_str!("input_help.rs").contains(r#""init""#),
            "/init has no detailed command help"
        );
    }

    #[test]
    fn init_does_not_steal_initiatives_in_session_dispatch() {
        let session = include_str!("commands.rs");
        let init_at = session
            .find("parse_init_command(trimmed)")
            .expect("local /init dispatch");
        let goals_at = session
            .find("handle_goals_command(app, trimmed)")
            .expect("local /initiatives dispatch");
        assert!(
            init_at < goals_at,
            "/init must be claimed before /initiatives so the names stay distinct"
        );
        assert_eq!(parse_init_command("/initiatives"), None);
        assert_eq!(parse_init_command("/initiatives resume"), None);
    }
}
