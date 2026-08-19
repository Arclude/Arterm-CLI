//! Conversion tests for remote device rows.
//!
//! `fetch` itself needs two machines and a network, so what is pinned here is
//! everything between the wire and the row — which is where a remote session
//! would quietly become a wrong or unusable row.

use super::*;

fn summary(id: &str) -> RemoteSessionSummary {
    RemoteSessionSummary {
        id: id.to_string(),
        short_name: "alpha".to_string(),
        icon: "🦊".to_string(),
        title: "Fix the parser".to_string(),
        prompt: "merhaba".to_string(),
        message_count: 8,
        user_message_count: 4,
        assistant_message_count: 4,
        created_at_ms: 1_700_000_000_000,
        last_message_at_ms: 1_700_000_600_000,
        working_dir: Some("/home/someone/project".to_string()),
        model: Some("glm-5.3".to_string()),
        estimated_tokens: 22_000,
        is_active: true,
    }
}

/// The peer's live flag is what the Active list reads. A current peer only
/// sets it when a process is still running; the row must not invent one
/// from recency on this side.
#[test]
fn an_active_flag_becomes_last_active_at() {
    let info = session_info_from(&summary("ses_a"), "island");
    assert!(info.last_active_at.is_some());
}

#[test]
fn an_idle_flag_leaves_last_active_at_empty() {
    let mut idle = summary("ses_b");
    idle.is_active = false;
    let info = session_info_from(&idle, "island");
    assert!(info.last_active_at.is_none());
}

/// The public path: a peer's session list becomes picker rows, then the
/// Active filter. A live flag survives an old last turn; a saved row
/// without one does not.
#[test]
fn a_peer_list_feeds_the_active_filter() {
    let live = session_info_from(&summary("ses_live"), "island");
    let mut idle = summary("ses_old");
    idle.is_active = false;
    idle.last_message_at_ms = 1_000_000_000_000;
    let idle = session_info_from(&idle, "island");

    let mut picker = super::super::SessionPicker::new(vec![live, idle]);
    picker.activate_active_filter();
    let visible: Vec<&str> = picker
        .visible_session_iter()
        .map(|session| session.id.as_str())
        .collect();
    assert_eq!(visible, vec!["ses_live"]);
    assert_eq!(
        picker.remote_device_for_session("ses_live").as_deref(),
        Some("island")
    );
}

/// The device is the only thing telling two machines apart under one heading,
/// so it has to be on the row itself.
#[test]
fn a_row_carries_the_device_it_came_from() {
    let info = session_info_from(&summary("ses_a"), "masaustu");
    assert_eq!(info.server_name.as_deref(), Some("masaustu"));
    assert!(
        info.search_index.contains("masaustu"),
        "typing the device name should find its sessions"
    );
}

/// Selecting the row has to resume it on the far end, so the target must name
/// the peer's own session id.
#[test]
fn a_row_resumes_the_session_the_peer_named() {
    let info = session_info_from(&summary("ses_a"), "masaustu");
    match info.resume_target {
        ResumeTarget::ArtermSession { session_id } => assert_eq!(session_id, "ses_a"),
        other => panic!("expected an arterm session target, got {other:?}"),
    }
}

/// A peer on an older build sends ids only. The row must still be usable — the
/// id standing in for the name — rather than blank.
#[test]
fn an_id_only_row_falls_back_to_the_id_for_its_name() {
    let thin = RemoteSessionSummary {
        id: "ses_b".to_string(),
        ..RemoteSessionSummary::default()
    };
    let info = session_info_from(&thin, "dizustu");
    assert_eq!(info.short_name, "ses_b");
    assert_eq!(info.message_count, 0);
    assert!(info.first_user_prompt.is_none());
}

/// A peer with a broken clock must not take the picker down with it.
#[test]
fn a_nonsense_timestamp_does_not_panic() {
    let skewed = RemoteSessionSummary {
        id: "ses_c".to_string(),
        created_at_ms: i64::MAX,
        last_message_at_ms: i64::MIN,
        ..RemoteSessionSummary::default()
    };
    let info = session_info_from(&skewed, "dizustu");
    assert_eq!(info.id, "ses_c");
}

/// An empty prompt is absence, not an empty first turn: the row should show
/// nothing there rather than a blank quote.
#[test]
fn an_empty_prompt_is_absent_rather_than_empty() {
    let quiet = RemoteSessionSummary {
        id: "ses_d".to_string(),
        prompt: String::new(),
        ..RemoteSessionSummary::default()
    };
    assert!(
        session_info_from(&quiet, "dizustu")
            .first_user_prompt
            .is_none()
    );
}
