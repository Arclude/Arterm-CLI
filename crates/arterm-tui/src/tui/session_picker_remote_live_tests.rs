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
    let remote = remote_row(
        "session_windows",
        "192.168.1.108:7644",
        true,
        now_ms - 120_000,
    );
    let recent_idle = remote_row(
        "session_recent",
        "192.168.1.108:7644",
        false,
        now_ms - 120_000,
    );
    let local = {
        let mut row = remote_row("session_dead", "local", false, now_ms);
        row.server_name = None;
        row
    };
    let mut picker = SessionPicker::new(vec![remote, recent_idle, local]);
    picker.activate_active_filter();
    let visible: Vec<&str> = picker
        .visible_session_iter_for_test()
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
        .visible_session_iter_for_test()
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
    assert!(picker.visible_session_iter_for_test().next().is_none());
}

#[test]
fn a_local_server_group_is_not_a_paired_device() {
    let now_ms = Utc::now().timestamp_millis();
    let mut local = remote_row("session_sloth", "summit", true, now_ms);
    local.server_name = Some("summit".to_string());
    let picker = SessionPicker::new_grouped(
        vec![ServerGroup {
            name: "summit".to_string(),
            icon: "⛰".to_string(),
            version: String::new(),
            git_hash: String::new(),
            is_running: true,
            sessions: vec![local],
        }],
        Vec::new(),
    );
    assert_eq!(
        picker.remote_device_for_session("session_sloth"),
        None,
        "selecting a local grouped row must resume here, not peer-switch to the server name"
    );
}

#[test]
fn active_filter_hides_a_detached_local_row_even_if_the_server_name_lingers() {
    let now_ms = Utc::now().timestamp_millis();
    let mut detached = remote_row("session_sloth", "summit", true, now_ms);
    detached.server_name = Some("summit".to_string());
    let remote = remote_row("session_windows", "island", true, now_ms);
    let mut picker = SessionPicker::new_grouped(
        vec![
            ServerGroup {
                name: "summit".to_string(),
                icon: "⛰".to_string(),
                version: String::new(),
                git_hash: String::new(),
                is_running: true,
                sessions: vec![detached],
            },
            ServerGroup {
                name: "Remote devices".to_string(),
                icon: "🖧".to_string(),
                version: String::new(),
                git_hash: String::new(),
                is_running: true,
                sessions: vec![remote],
            },
        ],
        Vec::new(),
    );
    picker.activate_active_filter();
    let visible: Vec<&str> = picker
        .visible_session_iter_for_test()
        .map(|session| session.id.as_str())
        .collect();
    assert_eq!(
        visible,
        vec!["session_windows"],
        "a leftover local server_name must not inflate Active"
    );
    assert_eq!(
        picker.remote_device_for_session("session_sloth"),
        None,
        "the local group is still this machine"
    );
    assert_eq!(
        picker
            .remote_device_for_session("session_windows")
            .as_deref(),
        Some("island")
    );
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

#[test]
fn remote_session_working_dir_reads_the_peers_own_dir() {
    let now_ms = Utc::now().timestamp_millis();
    // The peer advertised the session with its own Windows dir; the row keeps
    // it, and a switch must send exactly that dir — never this machine's cwd.
    let mut remote = remote_row("session_windows", "island", true, now_ms);
    remote.working_dir = Some("C:\\Users\\win\\project".to_string());
    let mut local = remote_row("session_local", "summit", true, now_ms);
    local.server_name = None;
    local.working_dir = Some("/home/me/project".to_string());
    let picker = SessionPicker::new_grouped(
        vec![
            ServerGroup {
                name: "summit".to_string(),
                icon: "⛰".to_string(),
                version: String::new(),
                git_hash: String::new(),
                is_running: true,
                sessions: vec![local],
            },
            ServerGroup {
                name: "Remote devices".to_string(),
                icon: "🖧".to_string(),
                version: String::new(),
                git_hash: String::new(),
                is_running: true,
                sessions: vec![remote],
            },
        ],
        Vec::new(),
    );
    assert_eq!(
        picker
            .remote_session_working_dir("session_windows")
            .as_deref(),
        Some("C:\\Users\\win\\project"),
        "a remote row's own dir is what the peer switch must report"
    );
    assert_eq!(
        picker.remote_session_working_dir("session_local"),
        None,
        "a local row's dir is the local daemon's business, not a switch override"
    );
}
