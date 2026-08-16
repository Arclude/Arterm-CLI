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

use std::collections::HashMap;

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

    let mut summaries: Vec<RemoteServerSummary> = groups
        .into_iter()
        .map(|group| summary_from_sessions(group.name, group.icon, group.version, group.sessions))
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
        ));
    }

    summaries
}

/// A local `SessionInfo` trimmed for the wire.
fn session_summary_from(info: crate::tui::session_picker::SessionInfo) -> RemoteSessionSummary {
    RemoteSessionSummary {
        id: info.id,
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
        is_active: info.last_active_at.is_some(),
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
    // Unreachable, not listening, off this network: expected, and empty rather
    // than an error. This is the one swallow the design calls for — the reader
    // cannot tell an off device from an idle one, on purpose.
    match list_peer_sessions(&credentials, &target).await {
        Ok(summaries) => Ok(summaries.into_iter().map(server_info_from).collect()),
        Err(_unreachable) => Ok(Vec::new()),
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
) -> RemoteServerSummary {
    let details: Vec<RemoteSessionSummary> =
        sessions.into_iter().map(session_summary_from).collect();
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
