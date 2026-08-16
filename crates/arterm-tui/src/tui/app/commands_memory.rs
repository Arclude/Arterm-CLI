//! The `/memory` slash command, including `/memory clean`.
//!
//! Lives in its own module rather than in `commands.rs` because that file is
//! over the code-size ratchet and may not grow. Moving the whole `/memory`
//! family here is what buys the room for `clean`.
//!
//! `clean` deletes project memory and cannot be undone, so a bare
//! `/memory clean` never deletes: it reports what it *would* remove and opens a
//! confirmation modal, drawn by [`crate::tui::ui_overlays`] over the transcript
//! it is about to delete from. ←/→ move between Delete and Cancel, Enter
//! applies the highlighted one, and the modal opens on Cancel so a reflex Enter
//! is harmless. `--yes` stays as the non-interactive spelling and skips the
//! modal entirely, mirroring the CLI flag.

use crossterm::event::KeyCode;

use super::{App, DisplayMessage};
use crate::memory::MemoryManager;
use crate::memory_clean::{clear_projects_dir, projects_dir, remove_store_at};

pub(crate) const USAGE: &str = "Usage: /memory [on|off|status|clean]";

/// Handle every `/memory ...` command for a local session.
///
/// Returns false when `trimmed` is not a `/memory` command at all, so the
/// caller keeps matching other commands.
pub(crate) fn handle_memory_command(app: &mut App, trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("/memory") else {
        return false;
    };
    // `/memoryfoo` is not `/memory foo`.
    if !rest.is_empty() && !rest.starts_with(' ') {
        return false;
    }

    match rest.trim() {
        "" => {
            let new_state = !app.memory_enabled;
            set_memory(app, new_state);
        }
        "on" => set_memory(app, true),
        "off" => set_memory(app, false),
        "status" => push_status(app),
        other => {
            let working_dir = app.session.working_dir.clone();
            match handle_clean_arg(other, working_dir.as_deref()) {
                Some(outcome) => push_outcome(app, outcome),
                None => app.push_display_message(DisplayMessage::error(USAGE.to_string())),
            }
        }
    }
    true
}

fn set_memory(app: &mut App, enabled: bool) {
    app.set_memory_feature_enabled(enabled);
    app.set_status_notice(format!("Memory: {}", if enabled { "ON" } else { "OFF" }));
    app.push_display_message(DisplayMessage::system(format!(
        "Memory feature {} for this session.",
        if enabled { "enabled" } else { "disabled" }
    )));
}

fn enabled_label(enabled: bool) -> &'static str {
    if enabled { "enabled" } else { "disabled" }
}

/// Completions offered after `/memory `.
///
/// Kept beside the command itself so a new subcommand cannot be added without
/// the picker learning about it — `clean` existed as a CLI subcommand for a
/// while with nothing here, and to a user that reads as the command not
/// existing at all.
pub(crate) fn suggestions() -> Vec<(String, &'static str)> {
    vec![
        ("/memory on".into(), "Enable memory for this session"),
        ("/memory off".into(), "Disable memory for this session"),
        ("/memory status".into(), "Show memory feature status"),
        (
            "/memory clean".into(),
            "Delete this project's stored memory (asks first)",
        ),
        (
            "/memory clean --all-projects".into(),
            "Delete every project's stored memory (asks first)",
        ),
    ]
}

/// Push the `/memory status` line. Shared with the remote command path, which
/// reports the same session flag and config default.
pub(crate) fn push_status(app: &mut App) {
    let default_enabled = crate::config::config().features.memory;
    app.push_display_message(DisplayMessage::system(format!(
        "Memory feature: {} (config default: {})",
        enabled_label(app.memory_enabled),
        enabled_label(default_enabled)
    )));
}

/// Handle a `/memory <rest>` argument from the client command path.
///
/// Only the clean family lands here; the on/off/status arms need a protocol
/// call and stay with the caller. Returns false when `rest` is none of them, so
/// the caller falls through to its usage error.
pub(crate) fn handle_remote_extra(app: &mut App, rest: &str) -> bool {
    let working_dir = app.session.working_dir.clone();
    match handle_clean_arg(rest, working_dir.as_deref()) {
        Some(outcome) => {
            push_outcome(app, outcome);
            true
        }
        None => false,
    }
}

/// Render a [`CleanOutcome`], so both command paths word it identically, and
/// arm the confirmation when there is one.
fn push_outcome(app: &mut App, outcome: CleanOutcome) {
    match outcome {
        // No chat message: the modal is the prompt, and echoing it into the
        // transcript would leave a stale copy behind after the answer.
        CleanOutcome::Confirm(pending) => app.pending_memory_clean = Some(pending),
        CleanOutcome::Done(text) => {
            app.push_display_message(DisplayMessage::system(text));
        }
        CleanOutcome::Usage(text) => {
            app.push_display_message(DisplayMessage::error(text));
        }
    }
}

/// What `/memory clean` should print, and whether it changed anything.
///
/// Returned as text rather than pushed onto the app so both the local and the
/// remote command paths can render it without duplicating the wording.
pub(crate) enum CleanOutcome {
    /// Nothing was deleted yet: arm this confirmation and let the modal ask.
    Confirm(PendingMemoryClean),
    /// Something was deleted (or there was nothing to delete).
    Done(String),
    /// The request did not make sense; show this as an error.
    Usage(String),
}

/// A `/memory clean` waiting on the confirmation modal.
///
/// The scope and working dir are captured when the command runs, not when the
/// key arrives, so the delete cannot drift onto a different project if the
/// session moves in between.
pub(crate) struct PendingMemoryClean {
    scope: CleanScope,
    working_dir: Option<String>,
    title: String,
    lines: Vec<String>,
    /// Starts false, so the highlighted choice is Cancel and a reflex Enter
    /// does not delete anything.
    delete_selected: bool,
}

impl App {
    /// The confirmation modal to draw, if one is armed.
    pub(crate) fn memory_clean_confirm(&self) -> Option<crate::tui::MemoryCleanConfirmView<'_>> {
        let pending = self.pending_memory_clean.as_ref()?;
        Some(crate::tui::MemoryCleanConfirmView {
            title: &pending.title,
            lines: &pending.lines,
            delete_selected: pending.delete_selected,
        })
    }
}

/// Resolve an armed `/memory clean`. Returns false when none is armed, so the
/// key falls through to normal handling.
///
/// Anything other than an explicit yes cancels: for a delete that cannot be
/// undone, an ambiguous keypress must not be read as consent.
pub(crate) fn handle_pending_confirm_key(app: &mut App, code: KeyCode) -> bool {
    // Taken up front, and put back only for a toggle: the two deciding arms
    // must leave nothing armed, and this way neither can forget to disarm.
    let Some(mut pending) = app.pending_memory_clean.take() else {
        return false;
    };
    match confirm_key_action(code, pending.delete_selected) {
        ConfirmKey::Toggle => {
            pending.delete_selected = !pending.delete_selected;
            app.pending_memory_clean = Some(pending);
        }
        ConfirmKey::Cancel => {
            app.push_display_message(DisplayMessage::system("Nothing was cleaned.".to_string()));
        }
        ConfirmKey::Delete => {
            let outcome = run_clean(pending.scope, true, pending.working_dir.as_deref());
            push_outcome(app, outcome);
        }
    }
    true
}

/// What a key means to an armed confirmation. Split from the handler so the
/// decision is testable without standing up an `App`.
#[derive(Debug, PartialEq, Eq)]
enum ConfirmKey {
    Toggle,
    Delete,
    Cancel,
}

fn confirm_key_action(code: KeyCode, delete_selected: bool) -> ConfirmKey {
    match code {
        KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab => ConfirmKey::Toggle,
        // `y` names the destructive choice outright, so it may delete from
        // either highlight; Enter only applies what is already highlighted.
        KeyCode::Char('y' | 'Y') => ConfirmKey::Delete,
        KeyCode::Enter if delete_selected => ConfirmKey::Delete,
        _ => ConfirmKey::Cancel,
    }
}

/// Handle any `/memory ...` argument that concerns cleaning.
///
/// `working_dir` is the session's, and it is not optional in practice: a
/// `MemoryManager` built without it has no project dir at all and reports that
/// there is nothing to clean, even with a store sitting on disk (the same trap
/// as issue #491, which is why the sidebar count scopes its manager too).
///
/// Returns `None` when `rest` is not a clean request, so the caller can fall
/// through to the on/off/status arms.
pub(crate) fn handle_clean_arg(rest: &str, working_dir: Option<&str>) -> Option<CleanOutcome> {
    let (scope, confirmed) = match rest.trim() {
        "clean" => (CleanScope::Project, false),
        "clean --yes" | "clean -y" => (CleanScope::Project, true),
        "clean --all-projects" => (CleanScope::AllProjects, false),
        "clean --all-projects --yes" | "clean --yes --all-projects" => {
            (CleanScope::AllProjects, true)
        }
        other if other.starts_with("clean") => {
            return Some(CleanOutcome::Usage(
                "Usage: /memory clean [--all-projects] [--yes]".to_string(),
            ));
        }
        _ => return None,
    };
    // Checked before anything is deleted, and here rather than at the call
    // sites so neither the local nor the client path can skip it.
    if server_is_remote_peer() {
        return Some(CleanOutcome::Usage(remote_clean_unsupported()));
    }
    Some(run_clean(scope, confirmed, working_dir))
}

/// Whether this session's server runs on another machine.
///
/// An ordinary arterm session is *already* a client/server pair over a local
/// socket, so "this went through the client command path" says nothing about
/// which machine the files live on — assuming otherwise made `/memory clean`
/// refuse in every normal session. What actually distinguishes the two is the
/// socket: `arterm device connect` points `ARTERM_SOCKET` at a relay it names
/// `arterm-peer-<id>.sock`, kept well away from `arterm.sock` precisely so
/// nothing mistakes it for the local daemon. Anything else is this machine.
fn server_is_remote_peer() -> bool {
    socket_is_remote_peer(&crate::server::socket_path())
}

/// The naming rule behind [`server_is_remote_peer`], taking the path so it is
/// testable without mutating `ARTERM_SOCKET` under every other test.
fn socket_is_remote_peer(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("arterm-peer-"))
}

#[derive(Clone, Copy)]
enum CleanScope {
    Project,
    AllProjects,
}

/// A manager scoped to the session's project, so it resolves the same
/// `projects/<hash>.json` the memory tool writes and the sidebar counts.
fn project_manager(working_dir: Option<&str>) -> MemoryManager {
    match working_dir {
        Some(dir) if !dir.trim().is_empty() => MemoryManager::new().with_project_dir(dir),
        _ => MemoryManager::new(),
    }
}

fn run_clean(scope: CleanScope, confirmed: bool, working_dir: Option<&str>) -> CleanOutcome {
    match scope {
        CleanScope::Project => clean_project(confirmed, working_dir),
        CleanScope::AllProjects => clean_all_projects(confirmed),
    }
}

fn clean_project(confirmed: bool, working_dir: Option<&str>) -> CleanOutcome {
    let manager = project_manager(working_dir);
    let path = match manager.project_memory_path() {
        Ok(Some(path)) => path,
        Ok(None) => {
            return CleanOutcome::Done(
                "This session has no project directory, so there is no project memory to clean."
                    .to_string(),
            );
        }
        Err(err) => return CleanOutcome::Usage(format!("Could not locate project memory: {err}")),
    };

    if !path.exists() {
        return CleanOutcome::Done("This project has no stored memory to clean.".to_string());
    }

    if !confirmed {
        // The graph, not `load_project()`. The store on disk is a MemoryGraph
        // (see `load_project_graph`, which tries that format first), so reading
        // it as the legacy MemoryStore fails and every real project previewed as
        // "an unreadable store" — the sidebar count reads the graph for the same
        // reason.
        let count = match manager.load_project_graph() {
            Ok(graph) if graph.memories.len() == 1 => "1 memory".to_string(),
            Ok(graph) => format!("{} memories", graph.memories.len()),
            // Something we cannot parse is still deletable, so preview it with
            // an honest unknown rather than refusing to say anything.
            Err(_) => "an unreadable store".to_string(),
        };
        return CleanOutcome::Confirm(PendingMemoryClean {
            scope: CleanScope::Project,
            working_dir: working_dir.map(str::to_string),
            title: "Clean project memory".to_string(),
            lines: vec![
                format!("This permanently deletes {count} from this project."),
                format!("  {}", path.display()),
                String::new(),
                "Global memory is not touched. This cannot be undone.".to_string(),
            ],
            delete_selected: false,
        });
    }

    match remove_store_at(&path) {
        Ok(true) => CleanOutcome::Done(
            "Cleaned this project's memory. Global memory is untouched.".to_string(),
        ),
        Ok(false) => CleanOutcome::Done("This project has no stored memory to clean.".to_string()),
        Err(err) => CleanOutcome::Usage(format!("Could not clean project memory: {err}")),
    }
}

fn clean_all_projects(confirmed: bool) -> CleanOutcome {
    let dir = match projects_dir() {
        Ok(dir) => dir,
        Err(err) => {
            return CleanOutcome::Usage(format!("Could not locate project memory: {err}"));
        }
    };

    if !confirmed {
        let stores = count_stores(&dir);
        if stores == 0 {
            return CleanOutcome::Done("No project memory to clean.".to_string());
        }
        let subject = if stores == 1 {
            "1 project's memory".to_string()
        } else {
            format!("{stores} projects' memory")
        };
        return CleanOutcome::Confirm(PendingMemoryClean {
            scope: CleanScope::AllProjects,
            working_dir: None,
            title: "Clean every project's memory".to_string(),
            lines: vec![
                format!("This permanently deletes {subject} on this machine."),
                format!("  {}", dir.display()),
                String::new(),
                "Global memory is not touched. This cannot be undone.".to_string(),
            ],
            delete_selected: false,
        });
    }

    match clear_projects_dir(&dir) {
        Ok(0) => CleanOutcome::Done("No project memory to clean.".to_string()),
        Ok(1) => CleanOutcome::Done(
            "Cleaned 1 project's memory. Global memory is untouched.".to_string(),
        ),
        Ok(n) => CleanOutcome::Done(format!(
            "Cleaned {n} projects' memory. Global memory is untouched."
        )),
        Err(err) => CleanOutcome::Usage(format!("Could not clean project memory: {err}")),
    }
}

/// How many `<hash>.json` stores sit in `dir`. Best-effort: an unreadable
/// directory counts as zero rather than failing the preview.
fn count_stores(dir: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".json"))
        })
        .count()
}

/// The message shown for a `/memory clean` typed at a remote session.
///
/// The delete primitives act on local disk, and the protocol has no message for
/// clearing memory on the far side. Cleaning the wrong machine's memory
/// silently would be worse than refusing, so this refuses and says where to run
/// it.
pub(crate) fn remote_clean_unsupported() -> String {
    "/memory clean only works on a local session — it would delete this machine's memory, \
     not the remote one's. Run `arterm memory clean` on that machine instead."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_text(rest: &str) -> Option<String> {
        match handle_clean_arg(rest, None) {
            Some(CleanOutcome::Usage(text)) => Some(text),
            _ => None,
        }
    }

    /// The confirmation is the point of the command: a bare `/memory clean`
    /// must never reach a delete, and must open on the safe choice.
    #[test]
    fn a_bare_clean_asks_before_it_deletes() {
        let outcome =
            handle_clean_arg("clean --all-projects", None).expect("clean is a clean request");
        match outcome {
            CleanOutcome::Confirm(pending) => {
                assert!(
                    !pending.delete_selected,
                    "the modal must open on Cancel, so a reflex Enter deletes nothing"
                );
                assert!(
                    pending.lines.iter().any(|l| l.contains("cannot be undone")),
                    "the modal must say the delete is irreversible, got: {:?}",
                    pending.lines
                );
                assert!(matches!(pending.scope, CleanScope::AllProjects));
            }
            // Done is what an empty machine returns; it deleted nothing either way.
            CleanOutcome::Done(_) => {}
            CleanOutcome::Usage(text) => panic!("unexpected usage error: {text}"),
        }
    }

    /// Arrow keys move the highlight and must not decide anything.
    #[test]
    fn arrows_only_move_the_highlight() {
        for code in [
            KeyCode::Left,
            KeyCode::Right,
            KeyCode::Tab,
            KeyCode::BackTab,
        ] {
            assert_eq!(confirm_key_action(code, false), ConfirmKey::Toggle);
            assert_eq!(confirm_key_action(code, true), ConfirmKey::Toggle);
        }
    }

    /// Enter applies whatever is highlighted, so it only deletes once the user
    /// has moved onto the destructive choice.
    #[test]
    fn enter_follows_the_highlight() {
        assert_eq!(
            confirm_key_action(KeyCode::Enter, false),
            ConfirmKey::Cancel
        );
        assert_eq!(confirm_key_action(KeyCode::Enter, true), ConfirmKey::Delete);
    }

    /// `y` names the destructive choice outright, so it deletes from either
    /// highlight — unlike Enter, it cannot be pressed by reflex.
    #[test]
    fn y_deletes_from_either_highlight() {
        assert_eq!(
            confirm_key_action(KeyCode::Char('y'), false),
            ConfirmKey::Delete
        );
        assert_eq!(
            confirm_key_action(KeyCode::Char('Y'), true),
            ConfirmKey::Delete
        );
    }

    /// Anything unrecognised cancels. An irreversible delete must not read an
    /// ambiguous keypress as consent.
    #[test]
    fn an_unrecognised_key_cancels() {
        for code in [KeyCode::Esc, KeyCode::Char('n'), KeyCode::Char('q')] {
            assert_eq!(confirm_key_action(code, true), ConfirmKey::Cancel);
        }
    }

    /// `--yes` stays as the non-interactive spelling, so it must skip the
    /// prompt rather than arm one nothing will answer.
    #[test]
    fn an_explicit_yes_does_not_arm_a_confirmation() {
        // Scoped to a directory that has no store, so this deletes nothing.
        let outcome = handle_clean_arg("clean --yes", Some("/nonexistent/project/xyz"))
            .expect("clean is a clean request");
        assert!(
            !matches!(outcome, CleanOutcome::Confirm(..)),
            "--yes must not ask again"
        );
    }

    /// The second bug this command shipped with: `MemoryManager::new()` alone
    /// has no project dir, so a session with 32 stored memories was told it had
    /// none. The manager must be scoped to the session's working dir, the same
    /// way the sidebar count is.
    #[test]
    fn the_manager_is_scoped_to_the_sessions_working_dir() {
        let scoped = project_manager(Some("/home/someone/project"));
        let unscoped = project_manager(None);
        assert_ne!(
            scoped.project_memory_path().unwrap(),
            unscoped.project_memory_path().unwrap(),
            "a scoped manager must resolve a different store than an unscoped one"
        );
        assert!(
            scoped.project_memory_path().unwrap().is_some(),
            "a scoped manager must resolve a store path at all"
        );
    }

    /// A blank working dir is the same as none — it must not resolve to a store
    /// keyed on the empty string.
    #[test]
    fn a_blank_working_dir_is_treated_as_absent() {
        assert_eq!(
            project_manager(Some("   ")).project_memory_path().unwrap(),
            project_manager(None).project_memory_path().unwrap()
        );
    }

    #[test]
    fn a_non_clean_argument_falls_through_to_the_other_arms() {
        assert!(handle_clean_arg("on", None).is_none());
        assert!(handle_clean_arg("off", None).is_none());
        assert!(handle_clean_arg("status", None).is_none());
    }

    #[test]
    fn a_misspelled_clean_flag_explains_the_usage_instead_of_deleting() {
        assert_eq!(
            usage_text("clean --all").as_deref(),
            Some("Usage: /memory clean [--all-projects] [--yes]")
        );
        assert_eq!(
            usage_text("clean everything").as_deref(),
            Some("Usage: /memory clean [--all-projects] [--yes]")
        );
    }

    #[test]
    fn the_all_projects_flag_is_accepted_in_either_order() {
        // Both spellings must reach a clean, not the usage error.
        for rest in ["clean --all-projects --yes", "clean --yes --all-projects"] {
            assert!(
                usage_text(rest).is_none(),
                "{rest} should be accepted, not rejected as usage"
            );
        }
    }

    #[test]
    fn the_remote_message_names_the_command_to_run_there() {
        let msg = remote_clean_unsupported();
        assert!(msg.contains("arterm memory clean"));
    }

    /// The bug this guard exists for: an ordinary session is a client/server
    /// pair over `arterm.sock`, and treating that as remote made `/memory
    /// clean` refuse to do anything in the only case that matters.
    #[test]
    fn this_machines_sockets_are_not_remote_peers() {
        for name in ["arterm.sock", "arterm-debug.sock", "my-custom.sock"] {
            let path = std::path::Path::new("/run/user/1000").join(name);
            assert!(
                !socket_is_remote_peer(&path),
                "{name} is served by this machine"
            );
        }
    }

    /// The relay `arterm device connect` binds is the one case where the
    /// session's files live on another machine.
    #[test]
    fn a_peer_relay_socket_is_remote() {
        assert!(socket_is_remote_peer(std::path::Path::new(
            "/run/user/1000/arterm-peer-0123456789abcdef.sock"
        )));
    }

    #[test]
    fn a_path_without_a_file_name_is_not_remote() {
        assert!(!socket_is_remote_peer(std::path::Path::new("/")));
    }
}
