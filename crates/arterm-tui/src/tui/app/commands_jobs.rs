//! `/jobs`: interactive overlay of background bash/build/docker jobs.
//!
//! Local sessions snapshot `BackgroundTaskManager` in-process. Remote sessions
//! send `Request::BgAction` and repaint from `ServerEvent::BgTaskList`.

use crate::background;
use crate::bus::BackgroundTaskStatus;
use crate::protocol::BgTaskSummary;
use crate::tui::jobs_picker::{JobsPicker, JobsPickerOutcome};

use super::{App, DisplayMessage};

pub(super) fn handle_jobs_command(app: &mut App, trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("/jobs") else {
        return false;
    };
    if !rest.is_empty() && !rest.starts_with(' ') {
        return false;
    }
    match rest.trim() {
        "" | "all" => {
            let all_sessions = rest.trim() == "all";
            app.open_jobs_picker(all_sessions);
            true
        }
        _ => {
            app.push_display_message(DisplayMessage::error(
                "Usage: /jobs (this session) or /jobs all (every session). \
                 x stops a running job, r refreshes, a toggles all sessions."
                    .to_string(),
            ));
            true
        }
    }
}

impl App {
    pub(in crate::tui) fn open_jobs_picker(&mut self, all_sessions: bool) {
        let rows = if self.is_remote {
            Vec::new()
        } else {
            snapshot_jobs(all_sessions, Some(self.session.id.as_str()))
        };
        self.jobs_picker_overlay = Some(JobsPicker::new(rows, all_sessions));
        if self.is_remote {
            self.pending_jobs_list = true;
        }
        self.request_full_redraw();
    }

    pub(in crate::tui) fn handle_jobs_picker_key_outcome(
        &mut self,
        code: crossterm::event::KeyCode,
        modifiers: crossterm::event::KeyModifiers,
    ) -> Option<JobsPickerOutcome> {
        let picker = self.jobs_picker_overlay.as_mut()?;
        let outcome = picker.handle_key(code, modifiers);
        self.request_full_redraw();
        match outcome {
            JobsPickerOutcome::Stay => None,
            JobsPickerOutcome::Close => {
                self.jobs_picker_overlay = None;
                None
            }
            action @ JobsPickerOutcome::Action { .. } => Some(action),
        }
    }

    pub(in crate::tui) fn handle_jobs_picker_action_local(&mut self, outcome: JobsPickerOutcome) {
        let JobsPickerOutcome::Action {
            action,
            task_id,
            all_sessions,
        } = outcome
        else {
            return;
        };
        match action {
            "list" => {
                let rows = snapshot_jobs(all_sessions, Some(self.session.id.as_str()));
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_rows(rows);
                }
            }
            "cancel" => {
                let Some(task_id) = task_id else {
                    return;
                };
                if self.pending_jobs_cancel.is_some() {
                    if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                        picker.set_status("⏳ already stopping a job...".to_string());
                    }
                    self.request_full_redraw();
                    return;
                }
                // Cancel off the TUI thread. A miss (already finished / unknown
                // id) lands in the footer the same way remote BgAction errors
                // do, instead of leaving the ⏳ note forever.
                let (tx, rx) = std::sync::mpsc::channel();
                self.pending_jobs_cancel = Some(rx);
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        let _ = tx.send(local_jobs_cancel_result(&task_id, all_sessions).await);
                    });
                } else {
                    std::thread::spawn(move || {
                        let result = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .map(|rt| rt.block_on(local_jobs_cancel_result(&task_id, all_sessions)))
                            .unwrap_or_else(|error| super::LocalJobsCancelResult::Failed {
                                message: error.to_string(),
                            });
                        let _ = tx.send(result);
                    });
                }
            }
            _ => {}
        }
        self.request_full_redraw();
    }

    pub(in crate::tui) fn poll_jobs_cancel(&mut self) -> bool {
        let Some(rx) = self.pending_jobs_cancel.as_ref() else {
            return false;
        };
        let result = match rx.try_recv() {
            Ok(result) => result,
            Err(std::sync::mpsc::TryRecvError::Empty) => return false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.pending_jobs_cancel = None;
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_status("Background job cancel failed: worker dropped.".to_string());
                }
                self.request_full_redraw();
                return true;
            }
        };
        self.pending_jobs_cancel = None;
        match result {
            super::LocalJobsCancelResult::Stopped { all_sessions } => {
                let rows = snapshot_jobs(all_sessions, Some(self.session.id.as_str()));
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_rows(rows);
                }
            }
            super::LocalJobsCancelResult::NotRunning { task_id } => {
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_status(format!("Background job '{task_id}' is not running."));
                }
            }
            super::LocalJobsCancelResult::Failed { message } => {
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_status(format!("Background job cancel failed: {message}"));
                }
            }
        }
        self.request_full_redraw();
        true
    }

    pub(in crate::tui) fn apply_bg_task_list(&mut self, tasks: Vec<BgTaskSummary>) {
        if let Some(picker) = self.jobs_picker_overlay.as_mut() {
            picker.set_rows(tasks);
            self.request_full_redraw();
        }
    }

    /// Repaint `/jobs` when a background job finishes or reports progress.
    /// Local sessions snapshot in-process. Remote sessions request a list on
    /// the next tick so overlay Done never races a live turn.
    pub(in crate::tui) fn refresh_jobs_overlay_if_open(&mut self) {
        let Some(picker) = self.jobs_picker_overlay.as_ref() else {
            return;
        };
        if self.is_remote {
            self.pending_jobs_list = true;
            return;
        }
        let all_sessions = picker.all_sessions();
        let rows = snapshot_jobs(all_sessions, Some(self.session.id.as_str()));
        if let Some(picker) = self.jobs_picker_overlay.as_mut() {
            picker.set_rows(rows);
        }
        self.request_full_redraw();
    }
}

async fn local_jobs_cancel_result(
    task_id: &str,
    all_sessions: bool,
) -> super::LocalJobsCancelResult {
    match background::global().cancel(task_id).await {
        Ok(true) => super::LocalJobsCancelResult::Stopped { all_sessions },
        Ok(false) => super::LocalJobsCancelResult::NotRunning {
            task_id: task_id.to_string(),
        },
        Err(error) => super::LocalJobsCancelResult::Failed {
            message: format!("{error:#}"),
        },
    }
}

fn snapshot_jobs(all_sessions: bool, session_id: Option<&str>) -> Vec<BgTaskSummary> {
    let manager = background::global();
    manager
        .list_sync()
        .into_iter()
        .filter(|task| {
            all_sessions || session_id.is_none_or(|session_id| task.session_id == session_id)
        })
        .map(task_summary)
        .collect()
}

fn task_summary(task: background::TaskStatusFile) -> BgTaskSummary {
    BgTaskSummary {
        task_id: task.task_id,
        tool_name: task.tool_name.clone(),
        display_name: task.display_name,
        session_id: task.session_id,
        status: status_label(&task.status).to_string(),
        started_at: task.started_at,
        completed_at: task.completed_at,
        duration_secs: task.duration_secs,
        pid: task.pid,
        detached: task.detached,
        progress: task
            .progress
            .as_ref()
            .map(|progress| background::format_progress_display(progress, 10)),
        error: task.error,
    }
}

fn status_label(status: &BackgroundTaskStatus) -> &'static str {
    match status {
        BackgroundTaskStatus::Running => "running",
        BackgroundTaskStatus::Completed => "completed",
        BackgroundTaskStatus::Superseded => "superseded",
        BackgroundTaskStatus::Failed => "failed",
    }
}
