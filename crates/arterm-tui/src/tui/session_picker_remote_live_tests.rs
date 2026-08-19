use super::super::{ServerGroup, SessionPicker};
use super::session_info_from;
use chrono::{Duration as ChronoDuration, TimeZone, Utc};

fn remote_row(
    id: &str,
    device: &str,
    live: bool,
    last_message_at_ms: i64,
) -> super::super::SessionInfo {
    let mut row = session_info_from(
        &arterm_peer::RemoteSessionSummary {
            id: id.to_string(),
            short_name: id.to_string(),
            last_message_at_ms,
            is_active: live,
            ..Default::default()
        },
        device,
    );
    if !live {
        row.last_active_at = None;
        row.last_message_time = Utc
            .timestamp_millis_opt(last_message_at_ms)
            .single()
            .unwrap_or_else(Utc::now);
    }
    row
}

#[test]
fn active_filter_includes_paired_device_sessions_without_local_presence() {
    let now_ms = Utc::now().timestamp_millis();
    let remote = remote_row("session_windows", "192.168.1.108:7644", false, now_ms - 120_000);
    let local = {
        let mut row = remote_row("session_dead", "local", false, now_ms);
        row.server_name = None;
        row
    };
    let mut picker = SessionPicker::new(vec![remote, local]);
    picker.activate_active_filter();
    let visible: Vec<&str> = picker
        .visible_session_iter()
        .map(|session| session.id.as_str())
        .collect();
    assert_eq!(visible, vec!["session_windows"]);
    assert_eq!(
        picker
            .remote_device_for_session("session_windows")
            .as_deref(),
        Some("192.168.1.108:7644")
    );
}

#[test]
fn active_filter_includes_idle_live_remote_row() {
    let old_ms = (Utc::now() - ChronoDuration::hours(6)).timestamp_millis();
    let remote = remote_row("session_idle", "island", true, old_ms);
    let mut picker = SessionPicker::new(vec![remote]);
    picker.activate_active_filter();
    let visible: Vec<&str> = picker
        .visible_session_iter()
        .map(|session| session.id.as_str())
        .collect();
    assert_eq!(visible, vec!["session_idle"]);
}

#[test]
fn active_filter_hides_stale_paired_device_history() {
    let old_ms = (Utc::now() - ChronoDuration::hours(6)).timestamp_millis();
    let remote = remote_row("session_old", "192.168.1.108:7644", false, old_ms);
    let mut picker = SessionPicker::new(vec![remote]);
    picker.activate_active_filter();
    assert!(picker.visible_session_iter().next().is_none());
}

#[test]
fn remote_device_for_session_reads_grouped_rows() {
    let now_ms = Utc::now().timestamp_millis();
    let remote = remote_row("session_windows", "island", true, now_ms);
    let picker = SessionPicker::new_grouped(
        vec![ServerGroup {
            name: "Remote devices".to_string(),
            icon: "🖧".to_string(),
            version: String::new(),
            git_hash: String::new(),
            is_running: true,
            sessions: vec![remote],
        }],
        Vec::new(),
    );
    assert_eq!(
        picker
            .remote_device_for_session("session_windows")
            .as_deref(),
        Some("island")
    );
}
