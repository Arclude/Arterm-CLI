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
                let manager_task_id = task_id.clone();
                tokio::spawn(async move {
                    let _ = background::global().cancel(&manager_task_id).await;
                });
                if let Some(picker) = self.jobs_picker_overlay.as_mut() {
                    picker.set_status(format!(
                        "Stopping {task_id}... press r to refresh"
                    ));
                }
            }
            _ => {}
        }
        self.request_full_redraw();
    }

    pub(in crate::tui) fn apply_bg_task_list(&mut self, tasks: Vec<BgTaskSummary>) {
        if let Some(picker) = self.jobs_picker_overlay.as_mut() {
            picker.set_rows(tasks);
            self.request_full_redraw();
        }
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
