//! Start a fresh session from a task typed into the sessions manager.
//!
//! The manager already knows every live session; what it could not do was add
//! one. This is that step, and it reuses the two pieces the fork/"launch this
//! prompt elsewhere" path already relies on: a session saved to disk, and a
//! staged submission the client sends the moment it attaches.
//!
//! Unlike a fork, the new session starts empty. "Describe a task for a new
//! session" means a new thread of work, not a copy of this one — carrying the
//! current conversation across would put a wall of unrelated context in front
//! of the first prompt.

use super::App;
use crate::session::Session;
use crate::tui::app::DisplayMessage;
use arterm_session_types::ResumeTarget;

impl App {
    /// Create a session in this directory, stage `task` as its first prompt,
    /// and switch this terminal to it.
    ///
    /// Switching rather than opening a window keeps the gesture honest on a
    /// machine with no terminal emulator to spawn (SSH, a multiplexer pane):
    /// the session always exists and is always reachable, and the manager is
    /// one keystroke away again.
    pub(in crate::tui) fn start_session_with_task(&mut self, task: String) {
        let task = task.trim().to_string();
        if task.is_empty() {
            return;
        }

        let session_id = match self.create_session_for_task(&task) {
            Ok(id) => id,
            Err(error) => {
                self.push_display_message(DisplayMessage::error(format!(
                    "Could not start a new session: {error}"
                )));
                return;
            }
        };

        self.session_picker_overlay = None;
        self.handle_session_picker_current_terminal_selection(&[ResumeTarget::ArtermSession {
            session_id,
        }]);
    }

    /// Adopt a submission staged for a session this client just switched to.
    ///
    /// Staging is read at client startup, and an in-place switch never goes
    /// through startup: it asks the server to re-attach this same client
    /// (`RemoteConnection::resume_session`). Without this step the task written
    /// by the manager's composer sat unread on disk while the user watched an
    /// empty session -- the session existed, the prompt did not.
    pub(in crate::tui) fn adopt_staged_submission(&mut self, session_id: &str) {
        let Some(restored) = Self::restore_input_for_reload(session_id) else {
            return;
        };
        crate::logging::info(&format!(
            "Adopted a staged submission for {session_id} after switching in place"
        ));
        self.apply_restored_reload_input(restored);
    }

    /// The disk side: an empty session that inherits where and how this one
    /// runs, with the task staged as its first submission.
    fn create_session_for_task(&self, task: &str) -> anyhow::Result<String> {
        let mut session = Session::create(None, None);
        session.working_dir = self.session.working_dir.clone();
        session.model = self.session.model.clone();
        session.provider_key = self.session.provider_key.clone();
        session.subagent_model = self.session.subagent_model.clone();
        // Closed until a client attaches: an unattached session that claims to
        // be active shows up in the manager as a live one that answers nothing.
        session.status = crate::session::SessionStatus::Closed;
        session.save()?;

        App::save_startup_submission_for_session(&session.id, task.to_string(), Vec::new());
        crate::logging::info(&format!(
            "Sessions manager: started {} with a staged task",
            session.id
        ));
        Ok(session.id)
    }
}
