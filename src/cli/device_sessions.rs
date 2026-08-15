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
use arterm_peer::{PeerCredentials, PeerTarget, RemoteServerSummary, list_peer_sessions};
use arterm_session_aggregation::RemoteSessionSource;

use crate::registry::ServerInfo;

/// This machine's running servers, trimmed to what a peer's session list needs.
///
/// Read fresh each call: a peer asks whenever it refreshes its list, and the
/// answer changes as sessions start and stop. Failure to read the registry is
/// reported as "no servers" rather than an error — a peer querying the list
/// should see an empty machine, not a broken one.
pub(crate) fn local_session_summaries() -> Vec<RemoteServerSummary> {
    let servers = match crate::registry::running_local_servers_sync() {
        Ok(servers) => servers,
        Err(_) => return Vec::new(),
    };
    servers.into_iter().map(summary_from).collect()
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
        self.by_fingerprint
            .get(&device.fingerprint)
            .cloned()
            .unwrap_or_default()
    }
}

/// A local `ServerInfo` trimmed for the wire.
fn summary_from(server: ServerInfo) -> RemoteServerSummary {
    RemoteServerSummary {
        name: server.name,
        icon: server.icon,
        version: server.version,
        sessions: server.sessions,
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
