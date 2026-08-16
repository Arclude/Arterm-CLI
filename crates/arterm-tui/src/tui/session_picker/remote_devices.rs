//! Sessions running on paired machines, as rows in the picker.
//!
//! One group for every paired device together, not one per device: the list is
//! read far more often than it is acted on, and a machine that is asleep would
//! otherwise contribute an empty heading to every open. The device a row
//! belongs to travels on the row itself (`server_name`), so "which machine is
//! this?" is answerable without counting headings.
//!
//! Reaching a device is expected to fail. Asleep, off this network, or simply
//! not running `arterm device listen` all produce no rows rather than an error:
//! a reader cannot tell an off machine from an idle one, and should not have to.

use arterm_device::identity::Fingerprint;
use arterm_device::{DeviceIdentity, TrustStore, TrustedDevice};
use arterm_peer::tls::PeerCredentials;
use arterm_peer::{PeerTarget, RemoteSessionSummary, list_peer_sessions};
use chrono::{DateTime, TimeZone, Utc};

use super::{ResumeTarget, ServerGroup, SessionInfo, SessionSource, SessionStatus};

/// Heading the remote rows sit under.
pub const REMOTE_GROUP_NAME: &str = "Remote devices";

/// Ask every paired device what it is running.
///
/// Sequential rather than concurrent, matching the CLI: the list is small, and
/// a burst of TLS handshakes from a picker open is a worse neighbour on a home
/// network than a few hundred milliseconds of latency.
pub async fn fetch() -> Option<ServerGroup> {
    let (trust, credentials) = match peer_context() {
        Ok(context) => context,
        Err(error) => {
            crate::logging::warn(&format!("Not asking paired devices: {error:#}"));
            return None;
        }
    };

    let mut sessions = Vec::new();
    for device in trust.devices() {
        for summary in query_device(&credentials, device).await {
            for remote in summary.display_sessions() {
                sessions.push(session_info_from(&remote, &device.name));
            }
        }
    }

    (!sessions.is_empty()).then(|| ServerGroup {
        name: REMOTE_GROUP_NAME.to_string(),
        icon: "🖧".to_string(),
        version: String::new(),
        git_hash: String::new(),
        is_running: true,
        sessions,
    })
}

/// The paired devices and the credentials to reach them with, or the reason
/// there are none. Failing here is not the ordinary "that machine is asleep"
/// case — it means this machine cannot speak to any peer — so the caller logs it.
fn peer_context() -> anyhow::Result<(TrustStore, PeerCredentials)> {
    let trust = TrustStore::load()?;
    let identity = DeviceIdentity::load_or_create()?;
    let credentials = PeerCredentials::from_identity(&identity)?;
    Ok((trust, credentials))
}

/// One device's servers, or nothing if it cannot be reached.
async fn query_device(
    credentials: &PeerCredentials,
    device: &TrustedDevice,
) -> Vec<arterm_peer::RemoteServerSummary> {
    // No recorded address means the device has never connected, so there is
    // nowhere to ask.
    let Some(address) = device.address.clone() else {
        return Vec::new();
    };
    let Ok(fingerprint) = Fingerprint::from_hex(&device.fingerprint) else {
        return Vec::new();
    };
    let target = PeerTarget {
        address,
        fingerprint,
    };
    match list_peer_sessions(credentials, &target).await {
        Ok(servers) => servers,
        Err(error) => {
            // Expected often enough that it is not worth a row or a message,
            // but a log line is what separates "asleep" from "misconfigured"
            // when someone comes asking why their machine is missing.
            crate::logging::warn(&format!("Could not reach {}: {error:#}", device.name));
            Vec::new()
        }
    }
}

/// A remote summary as a picker row.
///
/// `server_name` carries the device, which is what the row prints and the only
/// thing distinguishing two machines under one heading.
fn session_info_from(remote: &RemoteSessionSummary, device: &str) -> SessionInfo {
    SessionInfo {
        id: remote.id.clone(),
        parent_id: None,
        short_name: if remote.short_name.is_empty() {
            remote.id.clone()
        } else {
            remote.short_name.clone()
        },
        icon: remote.icon.clone(),
        title: remote.title.clone(),
        message_count: remote.message_count,
        user_message_count: remote.user_message_count,
        assistant_message_count: remote.assistant_message_count,
        created_at: from_epoch_ms(remote.created_at_ms),
        last_message_time: from_epoch_ms(remote.last_message_at_ms),
        last_active_at: remote
            .is_active
            .then(|| from_epoch_ms(remote.last_message_at_ms)),
        working_dir: remote.working_dir.clone(),
        model: remote.model.clone(),
        provider_key: None,
        is_canary: false,
        is_debug: false,
        saved: false,
        save_label: None,
        status: SessionStatus::Active,
        needs_catchup: false,
        estimated_tokens: remote.estimated_tokens,
        first_user_prompt: (!remote.prompt.is_empty()).then(|| remote.prompt.clone()),
        messages_preview: Vec::new(),
        search_index: format!(
            "{} {} {} {}",
            device,
            remote.short_name.to_lowercase(),
            remote.title.to_lowercase(),
            remote.prompt.to_lowercase()
        ),
        server_name: Some(device.to_string()),
        server_icon: None,
        source: SessionSource::Arterm,
        resume_target: ResumeTarget::ArtermSession {
            session_id: remote.id.clone(),
        },
        external_path: None,
    }
}

/// Epoch milliseconds as a timestamp, treating an out-of-range value as the
/// epoch rather than panicking on a peer that sent nonsense.
fn from_epoch_ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_nanos(0))
}

#[cfg(test)]
#[path = "remote_devices_tests.rs"]
mod remote_devices_tests;
