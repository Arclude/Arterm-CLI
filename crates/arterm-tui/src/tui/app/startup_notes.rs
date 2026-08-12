//! Wiring for the startup screen's "where we left off" notes.
//!
//! The lines themselves are decided by [`crate::tui::startup_notes`]; this is
//! the part that gets the session list without making anyone wait for it. The
//! store holds every session ever opened, so the read runs on a blocking thread
//! and the notes appear on a later frame — the startup screen is already
//! re-rendered by the idle tick, so nothing has to be scheduled for them.
//!
//! The read is skipped entirely for a session that is not starting empty (a
//! resume already shows the history the notes would summarize) and when
//! `display.recent_notes` is 0.

use super::App;
use crate::tui::session_picker;
use crate::tui::startup_notes::notes_from_sessions;

impl App {
    /// Whether anyone has said anything yet in this session.
    ///
    /// System notices — a configured hotkey, a recovered session, an available
    /// update — are pushed before the first prompt and are not a conversation.
    /// Treating them as one is what hid the startup notes on a real machine.
    pub(in crate::tui) fn conversation_started(&self) -> bool {
        crate::tui::startup_notes::conversation_started(&self.display_messages)
    }

    /// Kick off the background session-store read, once per launch.
    pub(super) fn start_startup_notes_load(&mut self) {
        if self.startup_notes_limit() == 0 {
            return;
        }
        if self.conversation_started() {
            return;
        }
        if self.pending_startup_notes_load.is_some() || !self.startup_notes.is_empty() {
            return;
        }

        let (tx, rx) = std::sync::mpsc::channel();
        self.pending_startup_notes_load = Some(super::PendingStartupNotesLoad { receiver: rx });
        tokio::task::spawn_blocking(move || {
            let _ = tx.send(session_picker::load_sessions());
        });
    }

    /// Tick hook: adopt the session list once the read lands. Returns true when
    /// the startup screen gained notes and has to be repainted.
    pub(super) fn poll_startup_notes_load(&mut self) -> bool {
        let Some(pending) = self.pending_startup_notes_load.as_ref() else {
            return false;
        };
        let Ok(result) = pending.receiver.try_recv() else {
            return false;
        };
        self.pending_startup_notes_load = None;

        let sessions = match result {
            Ok(sessions) => sessions,
            Err(e) => {
                // Nothing to tell the user: the notes are a convenience, and a
                // session store that cannot be read will announce itself the
                // moment they open the picker.
                crate::logging::info(&format!("Startup notes unavailable: {e}"));
                return false;
            }
        };

        // A turn that started while the read was in flight has already answered
        // "where were we"; notes arriving now would push the conversation down
        // for nothing. A system notice is not a turn.
        if self.conversation_started() {
            return false;
        }

        let cwd = std::env::current_dir()
            .map(|dir| dir.display().to_string())
            .unwrap_or_default();
        self.startup_notes = notes_from_sessions(
            &sessions,
            &cwd,
            &self.session.id,
            self.startup_notes_limit(),
        );
        crate::logging::info(&format!(
            "Startup notes: {} of {} session(s) are recent work in {cwd}",
            self.startup_notes.len(),
            sessions.len()
        ));
        !self.startup_notes.is_empty()
    }

    fn startup_notes_limit(&self) -> usize {
        crate::config::config().display.recent_notes
    }
}
