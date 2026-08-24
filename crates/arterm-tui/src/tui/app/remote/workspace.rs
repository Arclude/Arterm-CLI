use super::{App, DisplayMessage, begin_remote_split_launch};
use crate::tui::backend::RemoteConnection;
use crate::tui::keybind::WorkspaceNavigationDirection;
use anyhow::Result;
use crossterm::event::{KeyCode, KeyModifiers};

pub(super) async fn handle_workspace_navigation_key(
    app: &mut App,
    code: KeyCode,
    modifiers: KeyModifiers,
    remote: &mut RemoteConnection,
) -> Result<bool> {
    if !app.workspace_client.is_enabled() {
        return Ok(false);
    }

    let Some(direction) = app.workspace_navigation_keys.direction_for(code, modifiers) else {
        return Ok(false);
    };

    let target = match direction {
        WorkspaceNavigationDirection::Left => app.workspace_client.navigate_left(),
        WorkspaceNavigationDirection::Right => app.workspace_client.navigate_right(),
        WorkspaceNavigationDirection::Up => app.workspace_client.navigate_up(),
        WorkspaceNavigationDirection::Down => app.workspace_client.navigate_down(),
    };

    if app.is_processing {
        app.set_status_notice("Finish current work before moving workspace focus");
        return Ok(true);
    }

    let Some(target_session_id) = target else {
        app.set_status_notice("No workspace session in that direction");
        return Ok(true);
    };
    remote.resume_session(&target_session_id).await?;
    let label = crate::id::extract_session_name(&target_session_id)
        .map(|name| name.to_string())
        .unwrap_or(target_session_id);
    app.set_status_notice(format!("Workspace → {}", label));
    Ok(true)
}

pub(super) async fn handle_workspace_command(
    app: &mut App,
    remote: &mut RemoteConnection,
    trimmed: &str,
) -> Result<bool> {
    if !trimmed.starts_with("/workspace") {
        return Ok(false);
    }

    let current_session = app
        .remote_session_id
        .as_deref()
        .or(app.resume_session_id.as_deref())
        .or(Some(app.session.id.as_str()));

    match trimmed {
        "/workspace" | "/workspace status" => {
            app.push_display_message(DisplayMessage::system(
                app.workspace_client.status_summary(),
            ));
            return Ok(true);
        }
        "/workspace on" | "/workspace import" => {
            app.workspace_client
                .enable(current_session, &app.remote_sessions);
            app.set_status_notice("Workspace mode enabled");
            app.push_display_message(DisplayMessage::system(
                app.workspace_client.status_summary(),
            ));
            return Ok(true);
        }
        "/workspace off" => {
            app.workspace_client.disable();
            app.set_status_notice("Workspace mode disabled");
            app.push_display_message(DisplayMessage::system("Workspace mode: off".to_string()));
            return Ok(true);
        }
        _ => {}
    }

    let target = match trimmed {
        "/workspace add" | "/workspace add right" => {
            Some(crate::tui::workspace_client::WorkspaceSplitTarget::Right)
        }
        "/workspace add up" => Some(crate::tui::workspace_client::WorkspaceSplitTarget::Up),
        "/workspace add down" => Some(crate::tui::workspace_client::WorkspaceSplitTarget::Down),
        _ => None,
    };

    if let Some(target) = target {
        app.workspace_client
            .enable(current_session, &app.remote_sessions);
        app.workspace_client.queue_split_target(target);
        app.pending_split_label = Some("Workspace".to_string());
        if app.is_processing {
            app.pending_split_request = true;
            app.push_display_message(DisplayMessage::system(
                "Workspace add queued - new session will be created when idle.".to_string(),
            ));
            app.set_status_notice("Workspace add queued");
        } else {
            begin_remote_split_launch(app, "Workspace");
            remote.split().await?;
        }
        return Ok(true);
    }

    app.push_display_message(DisplayMessage::system(
        "/workspace\n  Show workspace status.\n\n/workspace on\n  Enable/import workspace mode for current remote sessions.\n\n/workspace off\n  Disable workspace mode.\n\n/workspace add\n  Split current session and add it to the right in the current workspace row.\n\n/workspace add up\n  Split current session into the workspace above.\n\n/workspace add down\n  Split current session into the workspace below."
            .to_string(),
    ));
    Ok(true)
}

/// Apply a queued move to another machine, if one is waiting.
///
/// Returns whether the caller should drop this connection and reconnect. The
/// swap itself is only a socket change: `server::socket_path()` is read afresh
/// on every dial (`backend.rs`), so pointing `ARTERM_SOCKET` at the relay and
/// letting the run loop reconnect is the whole mechanism — no second connection
/// path, and the reload handoff stays untouched because none of its markers are
/// set.
///
/// The resume target has to move with it. The loop reconnects with
/// `reconnect_target_session_id()`, which is the session id this client is
/// already in; asking a *peer* to resume that id would name a session it has
/// never had. Clearing both ids and setting the peer's own is what makes this a
/// switch rather than a failed resume.
pub(in crate::tui::app) fn apply_pending_peer_switch(app: &mut App) -> bool {
    let Some(switch) = app.workspace_client.take_pending_peer_switch() else {
        return false;
    };
    let Some(socket) = switch.socket.to_str() else {
        app.push_display_message(DisplayMessage::error(
            "The relay socket path is not valid UTF-8, so the switch was abandoned.".to_string(),
        ));
        return false;
    };

    crate::server::set_socket_path(socket);
    app.remote_session_id = None;
    app.resume_session_id = switch.session_id;
    // The old machine's transcript must not stay on screen while the relay
    // dials. Leaving it there is what made a stuck switch look like the same
    // chat with a "Switching to …" notice on top.
    app.clear_display_messages();
    app.clear_streaming_render_state();
    app.set_remote_startup_phase(super::super::RemoteStartupPhase::Connecting);
    app.set_status_notice(format!("Switching to {}…", switch.device));
    true
}
