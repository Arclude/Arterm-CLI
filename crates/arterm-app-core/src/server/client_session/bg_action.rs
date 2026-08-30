//! The /jobs overlay's list and cancel actions, run server-side.

use crate::background;
use crate::bus::BackgroundTaskStatus;
use crate::protocol::{BgTaskSummary, ServerEvent};
use tokio::sync::mpsc;

/// Run a background-job action requested by the client's /jobs overlay.
///
/// `list` snapshots [`background::BackgroundTaskManager`]. `cancel` stops one
/// running task, then returns a fresh snapshot so the overlay can repaint.
pub(in crate::server) async fn handle_bg_action(
    id: u64,
    action: &str,
    task_id: Option<&str>,
    all_sessions: bool,
    session_id: &str,
    client_event_tx: &mpsc::UnboundedSender<ServerEvent>,
) {
    match action {
        "list" => {
            // Overlay paints from BgTaskList. Do not send Done: a resumed
            // remote turn has no current_message_id, so overlay Done would
            // look like the turn ended.
            send_task_list(id, all_sessions, session_id, client_event_tx).await;
        }
        "cancel" => {
            let Some(task_id) = task_id.filter(|id| !id.is_empty()) else {
                let _ = client_event_tx.send(ServerEvent::Error {
                    id,
                    message: "Background job cancel requires a task id.".to_string(),
                    retry_after_secs: None,
                });
                return;
            };
            match background::global().cancel(task_id).await {
                Ok(true) => {
                    send_task_list(id, all_sessions, session_id, client_event_tx).await;
                }
                Ok(false) => {
                    let _ = client_event_tx.send(ServerEvent::Error {
                        id,
                        message: format!("Background job '{task_id}' is not running."),
                        retry_after_secs: None,
                    });
                }
                Err(error) => {
                    let _ = client_event_tx.send(ServerEvent::Error {
                        id,
                        message: format!("Background job cancel failed: {error:#}"),
                        retry_after_secs: None,
                    });
                }
            }
        }
        other => {
            let _ = client_event_tx.send(ServerEvent::Error {
                id,
                message: format!("Unsupported background job action '{other}'."),
                retry_after_secs: None,
            });
        }
    }
}

async fn send_task_list(
    id: u64,
    all_sessions: bool,
    session_id: &str,
    client_event_tx: &mpsc::UnboundedSender<ServerEvent>,
) {
    let manager = background::global();
    let mut tasks = manager.list().await;
    if !all_sessions {
        tasks.retain(|task| task.session_id == session_id);
    }
    let summaries = tasks.iter().map(task_summary).collect();
    let _ = client_event_tx.send(ServerEvent::BgTaskList {
        id,
        tasks: summaries,
    });
}

fn task_summary(task: &background::TaskStatusFile) -> BgTaskSummary {
    BgTaskSummary {
        task_id: task.task_id.clone(),
        tool_name: task.tool_name.clone(),
        display_name: task.display_name.clone(),
        session_id: task.session_id.clone(),
        status: status_label(&task.status).to_string(),
        started_at: task.started_at.clone(),
        completed_at: task.completed_at.clone(),
        duration_secs: task.duration_secs,
        pid: task.pid,
        detached: task.detached,
        progress: task
            .progress
            .as_ref()
            .map(|progress| background::format_progress_display(progress, 10)),
        error: task.error.clone(),
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

#[cfg(test)]
mod tests {
    use super::{handle_bg_action, task_summary};
    use crate::background::TaskStatusFile;
    use crate::bus::BackgroundTaskStatus;
    use crate::protocol::ServerEvent;

    fn running_task() -> TaskStatusFile {
        TaskStatusFile {
            task_id: "abc123".to_string(),
            tool_name: "bash".to_string(),
            display_name: Some("docker compose up".to_string()),
            session_id: "session_one".to_string(),
            status: BackgroundTaskStatus::Running,
            exit_code: None,
            error: None,
            started_at: "2026-08-27T10:00:00+00:00".to_string(),
            completed_at: None,
            duration_secs: None,
            pid: Some(4242),
            owner_pid: None,
            owner_instance: None,
            detached: true,
            notify: true,
            wake: false,
            progress: None,
            event_history: Vec::new(),
        }
    }

    #[test]
    fn summary_carries_elapsed_fields_for_the_overlay() {
        let summary = task_summary(&running_task());
        assert_eq!(summary.task_id, "abc123");
        assert_eq!(summary.tool_name, "bash");
        assert_eq!(summary.display_name.as_deref(), Some("docker compose up"));
        assert_eq!(summary.status, "running");
        assert_eq!(summary.pid, Some(4242));
        assert!(summary.detached);
        assert!(summary.duration_secs.is_none());
        assert!(summary.progress.is_none());
    }

    #[tokio::test]
    async fn list_and_cancel_round_trip_a_live_task() {
        let session_id = format!("session_jobs_{}", std::process::id());
        let info = crate::background::global()
            .spawn_with_notify(
                "bash",
                Some("wire overlay job".to_string()),
                &session_id,
                false,
                false,
                |_output| async {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    Ok(crate::background::TaskResult::completed(Some(0)))
                },
            )
            .await;

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        handle_bg_action(7, "list", None, false, &session_id, &tx).await;

        let ServerEvent::BgTaskList { id, tasks } = rx.recv().await.expect("list snapshot") else {
            panic!("list must answer with BgTaskList");
        };
        assert_eq!(id, 7);
        let listed = tasks
            .iter()
            .find(|task| task.task_id == info.task_id)
            .expect("live job must appear in this session's list");
        assert_eq!(listed.status, "running");
        assert_eq!(listed.display_name.as_deref(), Some("wire overlay job"));
        assert_eq!(listed.session_id, session_id);
        assert!(listed.started_at.contains('T'));
        assert!(
            rx.try_recv().is_err(),
            "list must not send Done; overlay paints from BgTaskList"
        );

        handle_bg_action(
            8,
            "cancel",
            Some(info.task_id.as_str()),
            false,
            &session_id,
            &tx,
        )
        .await;
        let ServerEvent::BgTaskList { id, tasks } = rx.recv().await.expect("cancel snapshot")
        else {
            panic!("cancel must answer with a refreshed BgTaskList");
        };
        assert_eq!(id, 8);
        let cancelled = tasks
            .iter()
            .find(|task| task.task_id == info.task_id)
            .expect("cancelled job stays in the snapshot");
        assert_eq!(cancelled.status, "failed");
        assert_eq!(cancelled.error.as_deref(), Some("Cancelled by user"));
        assert!(
            cancelled.duration_secs.is_some_and(|secs| secs >= 0.0),
            "cancelled job must carry elapsed time"
        );
        assert!(
            rx.try_recv().is_err(),
            "cancel must not send Done; overlay paints from BgTaskList"
        );

        handle_bg_action(9, "cancel", None, false, &session_id, &tx).await;
        let ServerEvent::Error { id, message, .. } = rx.recv().await.expect("missing id error")
        else {
            panic!("cancel without a task id must error");
        };
        assert_eq!(id, 9);
        assert!(message.contains("requires a task id"), "{message}");
    }
}
