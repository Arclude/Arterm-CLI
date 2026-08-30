//! State management for pending `ask_user` questions.
//!
//! The question arrives as a server event and is stored in
//! [`App::pending_ask_user`]. The user picks an option (digits, arrows,
//! Enter) or types a free-form answer; the pick updates the highlight
//! synchronously here, and the actual `ask_user_response` wire send happens
//! from the remote event loop (which owns the [`RemoteConnection`]) via
//! [`App::take_pending_ask_user_answer`].

use super::App;

/// What the user answered, ready to send once the event loop can write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingAskUserAnswer {
    pub request_id: String,
    pub selected_index: Option<usize>,
    pub custom: Option<String>,
}

impl App {
    /// Highlight option `index` (0-based). Out-of-range indices are ignored.
    pub(super) fn select_ask_user_option(&mut self, index: usize) {
        let Some(pending) = self.pending_ask_user.as_mut() else {
            return;
        };
        if index < pending.options.len() {
            pending.selected = index;
        }
    }

    /// Move the highlight by `delta` rows, wrapping around.
    pub(super) fn move_ask_user_selection(&mut self, delta: i32) {
        let Some(pending) = self.pending_ask_user.as_mut() else {
            return;
        };
        if pending.options.is_empty() {
            return;
        }
        let len = pending.options.len() as i32;
        let current = pending.selected as i32;
        pending.selected = ((current + delta).rem_euclid(len)) as usize;
    }

    /// Record a free-form typed answer for the pending question and clear the
    /// prompt. The event loop sends it.
    pub(super) fn answer_pending_ask_user_custom(&mut self, custom: String) {
        let Some(pending) = self.pending_ask_user.take() else {
            return;
        };
        if !pending.allow_custom && !pending.options.is_empty() {
            // Custom answers were disabled: restore and complain; the agent
            // still waits for a listed pick.
            self.set_status_notice("This question expects one of the listed options");
            self.pending_ask_user = Some(pending);
            return;
        }
        self.pending_ask_user_answer = Some(PendingAskUserAnswer {
            request_id: pending.request_id,
            selected_index: None,
            custom: Some(custom),
        });
    }

    /// Take the answer produced by Enter-on-highlight, or `None` when no
    /// question is pending.
    pub(super) fn take_pending_ask_user_answer(&mut self) -> Option<PendingAskUserAnswer> {
        self.pending_ask_user_answer.take()
    }

    /// Submit the currently highlighted option directly through a live
    /// connection (remote key path).
    pub(in crate::tui::app) async fn submit_ask_user_with(
        &mut self,
        remote: &mut crate::tui::backend::RemoteConnection,
    ) -> anyhow::Result<()> {
        let Some(pending) = self.pending_ask_user.take() else {
            return Ok(());
        };
        if pending.options.is_empty() {
            return Ok(());
        }
        let selected = pending.selected.min(pending.options.len() - 1);
        let request_id = pending.request_id.clone();
        remote
            .send_ask_user_response(&request_id, Some(selected), None)
            .await?;
        self.push_display_message(crate::tui::DisplayMessage::system(format!(
            "▸ {}",
            pending.options[selected].label
        )));
        Ok(())
    }

    /// Local-mode stub for the Enter submit path (local sessions have no
    /// ask_user today; the tool only exists on the server side). Records the
    /// answer for the local event loop to pick up.
    pub(super) fn submit_ask_user_selection(&mut self) -> anyhow::Result<()> {
        let Some(pending) = self.pending_ask_user.take() else {
            return Ok(());
        };
        if pending.options.is_empty() {
            return Ok(());
        }
        let selected = pending.selected.min(pending.options.len() - 1);
        let label = pending.options[selected].label.clone();
        self.pending_ask_user_answer = Some(PendingAskUserAnswer {
            request_id: pending.request_id,
            selected_index: Some(selected),
            custom: None,
        });
        self.push_display_message(crate::tui::DisplayMessage::system(format!(
            "▸ {}",
            label
        )));
        Ok(())
    }
}
