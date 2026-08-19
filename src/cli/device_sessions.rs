//! The glue between the peer transport and the cross-machine session list.
//!
//! Phase 2 built the connection; Phase 3 built the grouped list with a stub
//! ([`arterm_session_aggregation::NullRemoteSessions`]) where remote data would
//! arrive. This is the real source: it asks each paired device for its sessions
//! over the peer transport and hands them to `aggregate`.
//!
//! The querying is async and the aggregation's `RemoteSessionSource` is sync, so
//! the async work happens *before* `aggregate` — every device is asked up front,
//! and the results are handed to a plain lookup. Blocking on the transport from
//! inside the sync trait would mean calling `block_on` on a thread already
//! driving the runtime, which panics; prefetching sidesteps that entirely.
//!
//! Two conversions live here because the two crates that meet do not share a
//! type — `arterm-peer` speaks [`RemoteServerSummary`] (it does not depend on
//! the registry), `arterm-session-aggregation` speaks
//! [`crate::registry::ServerInfo`]. The CLI owns both, so the mapping is its job.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use arterm_device::{DeviceIdentity, Fingerprint, TrustStore, TrustedDevice};
use arterm_peer::{
    PeerCredentials, PeerTarget, RemoteServerSummary, RemoteSessionSummary, list_peer_sessions,
};
use arterm_session_aggregation::RemoteSessionSource;

use crate::registry::ServerInfo;

/// This machine's sessions, grouped by server, trimmed for a peer's list.
///
/// Grouped by the session picker's own loader rather than by the server
/// registry. The registry looks like the natural source — it has a per-server
/// `sessions` list — but nothing ever writes to it: `ServerRegistry::add_session`
/// and `remove_session` have no callers anywhere in the tree, so that list is
/// permanently empty. Building the answer from it filtered every session away
/// and reported every machine as idle, which is indistinguishable from a
/// machine that really is idle. That is why the whole feature looked like a
/// transport problem when the transport was fine.
///
/// Using the picker's loader also makes a remote list the same view as the
/// local one, rather than a poorer second parse of the same files.
///
/// Read fresh each call: a peer asks whenever it refreshes its list, and the
/// answer changes as sessions start and stop. A failure to read is reported as
/// "no servers" rather than an error — a peer querying the list should see an
/// empty machine, not a broken one.
pub(crate) fn local_session_summaries() -> Vec<RemoteServerSummary> {
    let Ok((groups, orphans)) = crate::tui::session_picker::load_sessions_grouped() else {
        return Vec::new();
    };
    // Live means a running process, the same signal the left-arrow Active
    // list uses locally. A disk stamp or SessionStatus::Active is leftover
    // from the last time the TUI opened, and would mark every saved
    // session live on the other machine.
    let live_ids = live_session_ids();

    let mut summaries: Vec<RemoteServerSummary> = groups
        .into_iter()
        .map(|group| {
            summary_from_sessions(
                group.name,
                group.icon,
                group.version,
                group.sessions,
                &live_ids,
            )
        })
        .collect();

    // Sessions whose server is no longer registered still live on disk and
    // still resume, so hiding them from a peer would make this machine look
    // emptier than it is.
    if !orphans.is_empty() {
        summaries.push(summary_from_sessions(
            "sessions".to_string(),
            "📁".to_string(),
            String::new(),
            orphans,
            &live_ids,
        ));
    }

    summaries
}

/// Session ids with a live process on this machine.
fn live_session_ids() -> HashSet<String> {
    crate::session::user_session_presence()
        .into_iter()
        .map(|presence| presence.session_id)
        .collect()
}

/// A local `SessionInfo` trimmed for the wire.
fn session_summary_from(
    info: crate::tui::session_picker::SessionInfo,
    live_ids: &HashSet<String>,
) -> RemoteSessionSummary {
    RemoteSessionSummary {
        id: info.id.clone(),
        short_name: info.short_name,
        icon: info.icon,
        title: info.title,
        // A session with no visible user turn yet has no prompt to show. That
        // is an empty row, not a failure to read one.
        prompt: info.first_user_prompt.unwrap_or_default(),
        message_count: info.message_count,
        user_message_count: info.user_message_count,
        assistant_message_count: info.assistant_message_count,
        created_at_ms: info.created_at.timestamp_millis(),
        last_message_at_ms: info.last_message_time.timestamp_millis(),
        working_dir: info.working_dir,
        model: info.model,
        estimated_tokens: info.estimated_tokens,
        is_active: live_ids.contains(&info.id),
    }
}

/// Ask every paired device for its sessions, concurrently, before aggregation.
///
/// Returns a source keyed by fingerprint. A device that is offline, not
/// listening, or off this network contributes nothing — the same empty result
/// the stub gave, but now it means "asked and heard nothing" rather than "never
/// asked". The reader cannot tell an off machine from an idle one, on purpose.
pub(crate) async fn fetch_remote_sessions(trust: &TrustStore) -> Result<PreloadedRemoteSessions> {
    let identity = DeviceIdentity::load_or_create().context("loading this device's identity")?;

    let mut by_fingerprint: HashMap<String, Vec<ServerInfo>> = HashMap::new();
    for device in trust.devices() {
        // A corrupt trust entry (a fingerprint that is not valid hex) is a real
        // fault and propagates; an unreachable device is expected and returns
        // empty. `query_device` keeps the two apart so a broken store does not
        // hide behind the same "no sessions" a sleeping laptop shows.
        let servers = query_device(&identity, device).await?;
        by_fingerprint.insert(device.fingerprint.clone(), servers);
    }
    Ok(PreloadedRemoteSessions { by_fingerprint })
}

async fn query_device(
    identity: &DeviceIdentity,
    device: &TrustedDevice,
) -> Result<Vec<ServerInfo>> {
    let Some(address) = device.address.clone() else {
        // No recorded address: the device has never connected, so there is
        // nowhere to ask. Empty, not an error.
        return Ok(Vec::new());
    };
    let fingerprint = Fingerprint::from_hex(&device.fingerprint)?;
    let credentials = PeerCredentials::from_identity(identity)?;
    let target = PeerTarget {
        address,
        fingerprint,
    };
    match list_peer_sessions(&credentials, &target).await {
        Ok(summaries) => Ok(summaries.into_iter().map(server_info_from).collect()),
        // Unreachable, not listening, off this network: expected, and empty
        // rather than an error. This is the one swallow the design calls for —
        // the reader cannot tell an off device from an idle one, on purpose.
        Err(unreachable) if unreachable.is_unreachable() => Ok(Vec::new()),
        // A device that answered and could not be understood is not asleep. It
        // still contributes no rows, because one broken peer must not empty the
        // whole list, but it says so where someone can find it: this was silent
        // for as long as the session list was capped at a handshake's 4 KiB,
        // and a hand-built probe was the only way to see the real error.
        Err(unusable) => {
            crate::logging::warn(&format!(
                "{} answered the session list with something unusable: {unusable}",
                device.name
            ));
            Ok(Vec::new())
        }
    }
}

/// Remote sessions already fetched, ready for the sync `RemoteSessionSource`.
pub(crate) struct PreloadedRemoteSessions {
    by_fingerprint: HashMap<String, Vec<ServerInfo>>,
}

impl RemoteSessionSource for PreloadedRemoteSessions {
    fn servers_for(&self, device: &TrustedDevice) -> Vec<ServerInfo> {
        match self.by_fingerprint.get(&device.fingerprint) {
            Some(servers) => servers.clone(),
            None => Vec::new(),
        }
    }
}

/// This machine's running servers, with their session lists filled in.
///
/// `running_local_servers_sync` is still the source for what only the local
/// view knows — socket, pid, host — but its `sessions` field is always empty
/// for the reason [`local_session_summaries`] documents, so the ids come from
/// the picker's loader and are matched to a server by name. A server the loader
/// does not know keeps its own (empty) list rather than borrowing another's.
pub(crate) fn local_servers_with_sessions() -> anyhow::Result<Vec<ServerInfo>> {
    let mut servers = crate::registry::running_local_servers_sync()?;
    let Ok((groups, _orphans)) = crate::tui::session_picker::load_sessions_grouped() else {
        return Ok(servers);
    };

    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for group in groups {
        by_name.insert(
            group.name,
            group.sessions.into_iter().map(|info| info.id).collect(),
        );
    }
    for server in &mut servers {
        if let Some(ids) = by_name.remove(&server.name) {
            server.sessions = ids;
        }
    }
    Ok(servers)
}

/// One server's sessions, trimmed for the wire.
///
/// `sessions` still carries the plain ids alongside the richer `details`: a
/// peer on a build that predates `details` reads that field and nothing else,
/// so dropping it would make this machine look empty to every older device.
fn summary_from_sessions(
    name: String,
    icon: String,
    version: String,
    sessions: Vec<crate::tui::session_picker::SessionInfo>,
    live_ids: &HashSet<String>,
) -> RemoteServerSummary {
    let details: Vec<RemoteSessionSummary> = sessions
        .into_iter()
        .map(|info| session_summary_from(info, live_ids))
        .collect();
    RemoteServerSummary {
        name,
        icon,
        version,
        sessions: details.iter().map(|detail| detail.id.clone()).collect(),
        details,
    }
}

/// A remote summary as a `ServerInfo`. Socket/pid/timestamps are placeholders:
/// `aggregate` stamps the host to `Remote`, and the grouped view shows the name,
/// version, and session names — never the local-only fields.
fn server_info_from(summary: RemoteServerSummary) -> ServerInfo {
    ServerInfo {
        name: summary.name,
        icon: summary.icon,
        version: summary.version,
        sessions: summary.sessions,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionStatus;
    use crate::tui::session_picker::{ResumeTarget, SessionInfo, SessionSource};
    use chrono::Utc;

    fn info(id: &str) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            parent_id: None,
            short_name: "sauropod".to_string(),
            icon: "s".to_string(),
            title: "Windows chat".to_string(),
            message_count: 2,
            user_message_count: 1,
            assistant_message_count: 1,
            created_at: Utc::now(),
            last_message_time: Utc::now(),
            last_active_at: Some(Utc::now()),
            working_dir: None,
            model: None,
            provider_key: None,
            is_canary: false,
            is_debug: false,
            saved: false,
            save_label: None,
            status: SessionStatus::Active,
            needs_catchup: false,
            estimated_tokens: 0,
            first_user_prompt: Some("hello".to_string()),
            messages_preview: Vec::new(),
            search_index: "sauropod".to_string(),
            server_name: None,
            server_icon: None,
            source: SessionSource::Arterm,
            resume_target: ResumeTarget::ArtermSession {
                session_id: id.to_string(),
            },
            external_path: None,
        }
    }

    #[test]
    fn a_saved_session_is_not_live_without_a_running_process() {
        let summary = session_summary_from(info("session_old"), &HashSet::new());
        assert!(
            !summary.is_active,
            "a disk stamp or Active status is leftover, not live"
        );
    }

    #[test]
    fn a_running_process_is_the_live_flag() {
        let live = HashSet::from(["session_open".to_string()]);
        let summary = session_summary_from(info("session_open"), &live);
        assert!(summary.is_active);
    }

    #[test]
    fn local_session_summaries_mark_only_running_processes_live() {
        let _guard = crate::storage::lock_test_env();
        let temp = tempfile::tempdir().expect("tempdir");
        let prev_home = std::env::var_os("ARTERM_HOME");
        crate::env::set_var("ARTERM_HOME", temp.path());
        crate::tui::session_picker::invalidate_session_list_cache();

        let id = "session_fox_livewire".to_string();
        let mut session = crate::session::Session::create_with_id(
            id.clone(),
            None,
            Some("Open chat".to_string()),
        );
        session.add_message(
            crate::message::Role::User,
            vec![crate::message::ContentBlock::Text {
                text: "hello from this machine".to_string(),
                cache_control: None,
            }],
        );
        session.mark_active();

        let summaries = local_session_summaries();
        let open = summaries
            .iter()
            .flat_map(|server| server.details.iter())
            .find(|row| row.id == id)
            .expect("saved session must be listed");
        assert!(
            open.is_active,
            "a TUI that just marked itself active must look live to a peer"
        );

        session.mark_closed();
        crate::tui::session_picker::invalidate_session_list_cache();
        let summaries = local_session_summaries();
        let closed = summaries
            .iter()
            .flat_map(|server| server.details.iter())
            .find(|row| row.id == id)
            .expect("closed session still lists");
        assert!(
            !closed.is_active,
            "closing the TUI must drop the live flag even if last_active_at stays on disk"
        );

        if let Some(prev_home) = prev_home {
            crate::env::set_var("ARTERM_HOME", prev_home);
        } else {
            crate::env::remove_var("ARTERM_HOME");
        }
        crate::tui::session_picker::invalidate_session_list_cache();
    }

    /// The public listen path: the same function `arterm device listen` answers
    /// with, over real TLS, then the same conversion the left-arrow Active
    /// list uses. A live process stays live; a leftover disk stamp does not.
    #[tokio::test(flavor = "multi_thread")]
    async fn device_listen_answers_with_live_flags_from_this_machine() {
        let _guard = crate::storage::lock_test_env();
        let temp = tempfile::tempdir().expect("tempdir");
        let prev_home = std::env::var_os("ARTERM_HOME");
        crate::env::set_var("ARTERM_HOME", temp.path());
        crate::tui::session_picker::invalidate_session_list_cache();

        let live_id = "session_fox_listen".to_string();
        let idle_id = "session_owl_saved".to_string();
        let mut live = crate::session::Session::create_with_id(
            live_id.clone(),
            None,
            Some("Open chat".to_string()),
        );
        live.add_message(
            crate::message::Role::User,
            vec![crate::message::ContentBlock::Text {
                text: "hello from this machine".to_string(),
                cache_control: None,
            }],
        );
        live.mark_active();

        let mut idle = crate::session::Session::create_with_id(
            idle_id.clone(),
            None,
            Some("Saved chat".to_string()),
        );
        idle.add_message(
            crate::message::Role::User,
            vec![crate::message::ContentBlock::Text {
                text: "an old turn".to_string(),
                cache_control: None,
            }],
        );
        idle.mark_active();
        idle.mark_closed();
        idle.save().expect("save closed session");
        crate::tui::session_picker::invalidate_session_list_cache();
        // Snapshot on this thread: `load_sessions_grouped` cannot block inside
        // the current-thread runtime the listener task would otherwise use.
        let snapshot = local_session_summaries();

        let host_dir = temp.path().join("host-device");
        let guest_dir = temp.path().join("guest-device");
        std::fs::create_dir_all(&host_dir).expect("host dir");
        std::fs::create_dir_all(&guest_dir).expect("guest dir");
        let host = arterm_device::DeviceIdentity::load_or_create_in(&host_dir).expect("host");
        let guest = arterm_device::DeviceIdentity::load_or_create_in(&guest_dir).expect("guest");
        let host_gate = arterm_peer::gate::TrustGate::in_dir(&host_dir);
        let guest_gate = arterm_peer::gate::TrustGate::in_dir(&guest_dir);
        host_gate
            .record_pairing(&guest.fingerprint(), "guest", None)
            .expect("host trusts guest");
        guest_gate
            .record_pairing(&host.fingerprint(), "host", None)
            .expect("guest trusts host");

        let host_creds = arterm_peer::tls::PeerCredentials::from_identity(&host).expect("host creds");
        let guest_creds =
            arterm_peer::tls::PeerCredentials::from_identity(&guest).expect("guest creds");
        let bind: std::net::SocketAddr = "127.0.0.1:0".parse().expect("bind");
        let listener = arterm_peer::listen::PeerListener::bind_with_policy(
            bind,
            &host_creds,
            host_gate,
            arterm_peer::subnet::SubnetPolicy::ThisMachine,
        )
        .await
        .expect("bind")
        .with_local_sessions(std::sync::Arc::new(move || snapshot.clone()));
        let addr = listener.local_addr();
        let serving = tokio::spawn(async move {
            match listener.accept().await.expect("accept") {
                arterm_peer::listen::Arrival::Pending(pending) => listener
                    .admitter()
                    .establish(pending)
                    .await
                    .expect("establish"),
                other => panic!("expected a pending peer, got {other:?}"),
            }
        });

        let reported = list_peer_sessions(
            &guest_creds,
            &PeerTarget {
                address: addr.to_string(),
                fingerprint: host.fingerprint(),
            },
        )
        .await
        .expect("list sessions over TLS");
        serving.abort();

        let details: Vec<_> = reported
            .iter()
            .flat_map(|server| server.details.iter())
            .collect();
        let open = details
            .iter()
            .find(|row| row.id == live_id)
            .expect("open session listed");
        let saved = details
            .iter()
            .find(|row| row.id == idle_id)
            .expect("saved session listed");
        assert!(open.is_active, "listen must report the open TUI as live");
        assert!(
            !saved.is_active,
            "listen must not report a closed session as live"
        );

        live.mark_closed();
        if let Some(prev_home) = prev_home {
            crate::env::set_var("ARTERM_HOME", prev_home);
        } else {
            crate::env::remove_var("ARTERM_HOME");
        }
        crate::tui::session_picker::invalidate_session_list_cache();
    }
}
