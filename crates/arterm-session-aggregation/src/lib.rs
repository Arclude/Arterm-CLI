//! One session list across every machine you have paired with, grouped by
//! device.
//!
//! Today the session picker shows the servers and sessions on *this* machine.
//! Cross-machine sessions add the ones running on paired devices. This crate is
//! the join: it takes the local server list ([`arterm_base::registry::ServerInfo`])
//! and the trust store ([`arterm_device::TrustStore`]) and produces a
//! [`DeviceGroup`] per machine — the local one first, then each paired device by
//! name — that the picker (and `arterm device sessions`) render directly.
//!
//! # No network here
//!
//! This phase deliberately builds against the trust store, not a live
//! connection. The devices come from what you have paired with; the *sessions*
//! on those devices arrive through [`RemoteSessionSource`], the one seam the peer
//! transport fills later. Until it lands, [`NullRemoteSessions`] reports nothing,
//! so a paired device shows up under its name with "no sessions reported yet".
//! That empty state is the point: it proves the grouping is real and wired
//! before any bytes cross the wire.

use arterm_base::registry::{ServerHost, ServerInfo};
use arterm_device::{TrustStore, TrustedDevice};

/// Display name for the local machine's group. The local device has no
/// fingerprint of its own in this view — it is always "here".
pub const LOCAL_DEVICE_NAME: &str = "this machine";

/// Which machine a [`DeviceGroup`] describes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    /// This machine.
    Local,
    /// A paired device, identified by its certificate fingerprint (hex).
    Remote { fingerprint: String },
}

/// One machine's servers in the aggregated session list.
///
/// `servers` is empty for a paired device the transport has not reached (or that
/// simply has nothing running). It is never absent — a paired device always gets
/// a group so it is visible even before it reports anything.
#[derive(Clone, Debug)]
pub struct DeviceGroup {
    pub kind: DeviceKind,
    /// Human label: [`LOCAL_DEVICE_NAME`] for the local machine, otherwise the
    /// trusted device's name.
    pub name: String,
    /// The device's last-known address (remote only; `None` for local).
    pub address: Option<String>,
    /// Servers reported on this device, each already stamped with its
    /// [`ServerHost`].
    pub servers: Vec<ServerInfo>,
}

impl DeviceGroup {
    /// Whether this is the local machine's group.
    pub fn is_local(&self) -> bool {
        matches!(self.kind, DeviceKind::Local)
    }

    /// The owning device's fingerprint, or `None` for the local group.
    pub fn fingerprint(&self) -> Option<&str> {
        match &self.kind {
            DeviceKind::Local => None,
            DeviceKind::Remote { fingerprint } => Some(fingerprint),
        }
    }

    /// Total sessions across every server on this device.
    pub fn session_count(&self) -> usize {
        self.servers.iter().map(|s| s.sessions.len()).sum()
    }

    /// Whether this device has reported any server at all. A paired device with
    /// `false` here is the "no sessions reported yet" case the transport fills.
    pub fn has_reports(&self) -> bool {
        !self.servers.is_empty()
    }
}

/// The seam the peer transport fills.
///
/// Given a device this machine trusts, return the servers currently running on
/// it. This crate ships only [`NullRemoteSessions`]; the peer-transport phase
/// implements this over its mutual-TLS connection, returning a [`ServerInfo`] per
/// remote server (the `host` field is re-stamped by [`aggregate`], so an
/// implementation may leave it `Local` and still be attributed correctly).
///
/// An empty vec means "nothing to report" — offline, not yet connected, or
/// genuinely idle. The three are indistinguishable here on purpose; only a live
/// transport can tell them apart, and this phase does not pretend to.
pub trait RemoteSessionSource {
    fn servers_for(&self, device: &TrustedDevice) -> Vec<ServerInfo>;
}

/// The Phase-3 stub: every paired device reports nothing.
///
/// Swapping this for the real transport is the whole of what Phase 2 wires into
/// the aggregation — no call site here changes.
pub struct NullRemoteSessions;

impl RemoteSessionSource for NullRemoteSessions {
    fn servers_for(&self, _device: &TrustedDevice) -> Vec<ServerInfo> {
        Vec::new()
    }
}

/// Group `local_servers` and every trusted device into one list: the local
/// machine first, then each paired device ordered by name.
///
/// Remote sessions come from `remote`; pass [`NullRemoteSessions`] for the
/// no-transport build. Every returned server has its [`ServerHost`] set to match
/// the device it belongs to, so callers can trust `host` without knowing which
/// group produced a server.
pub fn aggregate(
    local_servers: Vec<ServerInfo>,
    trust: &TrustStore,
    remote: &dyn RemoteSessionSource,
) -> Vec<DeviceGroup> {
    let mut groups = Vec::with_capacity(1 + trust.devices().len());

    // Local first, always — even with zero servers, so the list has a stable
    // anchor and "here" is never buried under a remote device.
    let local_servers = local_servers
        .into_iter()
        .map(|mut server| {
            server.host = ServerHost::Local;
            server
        })
        .collect();
    groups.push(DeviceGroup {
        kind: DeviceKind::Local,
        name: LOCAL_DEVICE_NAME.to_string(),
        address: None,
        servers: local_servers,
    });

    // Then each paired device, ordered by name so the list is stable run to run.
    // Case-insensitive, with the fingerprint as the tiebreak because two devices
    // may share a hostname (the trust store keys on fingerprint for that reason).
    let mut devices: Vec<&TrustedDevice> = trust.devices().iter().collect();
    devices.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.fingerprint.cmp(&b.fingerprint))
    });

    for device in devices {
        // Re-stamp every reported server as owned by this device, so a transport
        // that returns a bare ServerInfo is still correctly attributed and
        // dial-able through `host`.
        let servers = remote
            .servers_for(device)
            .into_iter()
            .map(|mut server| {
                server.host =
                    ServerHost::remote(device.fingerprint.clone(), device.address.clone());
                server
            })
            .collect();
        groups.push(DeviceGroup {
            kind: DeviceKind::Remote {
                fingerprint: device.fingerprint.clone(),
            },
            name: device.name.clone(),
            address: device.address.clone(),
            servers,
        });
    }

    groups
}

/// Render the grouped list as the plain text `arterm device sessions` prints.
///
/// Kept here rather than in the CLI so the grouped presentation is unit-testable
/// without capturing stdout.
pub fn render_plain(groups: &[DeviceGroup]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "Sessions across {} device(s) — local machine first, then paired devices:\n",
        groups.len()
    ));

    for group in groups {
        out.push('\n');
        match &group.kind {
            DeviceKind::Local => {
                out.push_str(&format!("🖥  {}\n", group.name));
            }
            DeviceKind::Remote { fingerprint } => {
                let address = group.address.as_deref().unwrap_or("address unknown");
                out.push_str(&format!(
                    "💻 {}  {}  {}\n",
                    group.name,
                    short_fingerprint(fingerprint),
                    address
                ));
            }
        }

        if !group.has_reports() {
            if group.is_local() {
                out.push_str("    no local servers running\n");
            } else {
                out.push_str(
                    "    no sessions reported yet — the peer transport (not in this build) \
                     will report these\n",
                );
            }
            continue;
        }

        for server in &group.servers {
            out.push_str(&format!(
                "    {} {} {} — {} session(s)\n",
                server.icon,
                server.name,
                server.version,
                server.sessions.len()
            ));
            if server.sessions.is_empty() {
                out.push_str("        (no active sessions)\n");
            } else {
                for session in &server.sessions {
                    out.push_str(&format!("        • {session}\n"));
                }
            }
        }
    }

    out
}

/// Short grouped form for a stored hex fingerprint, falling back to the raw
/// value when it is not one we can parse. Mirrors the `arterm device list`
/// shortener so the two views read the same.
fn short_fingerprint(hex: &str) -> String {
    match arterm_device::identity::Fingerprint::from_hex(hex) {
        Ok(fingerprint) => fingerprint.to_display(),
        Err(_) => hex.to_string(),
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod lib_tests;
