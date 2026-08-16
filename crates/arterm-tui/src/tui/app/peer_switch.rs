//! Opening a session that lives on a paired machine.
//!
//! The client never speaks the peer protocol itself. It puts a local socket in
//! front of the peer, points `ARTERM_SOCKET` at it, and reconnects — after
//! which the ordinary remote path is talking to the other machine's server
//! without knowing it. That is the same shape `arterm device connect` uses from
//! the shell, and it reuses the same splice
//! ([`arterm_peer::relay_local_stream`]) rather than a second implementation of
//! it.
//!
//! Setting up the relay is all this module does. The actual move happens on the
//! next tick, when [`super::remote::apply_pending_peer_switch`] swaps the socket
//! and the run loop reconnects.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use arterm_device::identity::Fingerprint;
use arterm_device::{DeviceIdentity, TrustStore};
use arterm_peer::PeerTarget;
use arterm_peer::tls::PeerCredentials;

use super::{App, DisplayMessage};
use crate::tui::workspace_client::PeerSwitch;

/// The socket this client was pointed at before its first peer switch — where
/// "back to this machine" leads.
///
/// Captured on the first switch rather than at startup because that is the last
/// moment it is still true, and because a client started with its own
/// `ARTERM_SOCKET` has to return *there*, not to the default daemon path.
static HOME_SOCKET: OnceLock<PathBuf> = OnceLock::new();

impl App {
    /// Route a chosen session to the machine that owns it.
    ///
    /// Returns false only when a paired device cannot be reached, so the caller
    /// can leave the picker open on a switch that will not happen; the reason is
    /// already on screen by then.
    pub(crate) fn begin_session_switch(
        &mut self,
        device: Option<&str>,
        session_id: String,
    ) -> bool {
        if let Some(device) = device {
            return self.begin_peer_session_switch(device, session_id);
        }

        match way_home(
            HOME_SOCKET.get().map(PathBuf::as_path),
            &crate::server::socket_path(),
        ) {
            Some(home) => self.workspace_client.queue_peer_switch(PeerSwitch {
                socket: home.to_path_buf(),
                session_id: Some(session_id),
                device: "this machine".to_string(),
            }),
            None => self.workspace_client.queue_resume_session(session_id),
        }
        true
    }

    /// Queue a move to `session_id` on `device`, standing up its relay first.
    fn begin_peer_session_switch(&mut self, device: &str, session_id: String) -> bool {
        let target = match resolve_target(device) {
            Ok(target) => target,
            Err(reason) => {
                self.push_display_message(DisplayMessage::error(reason));
                return false;
            }
        };

        let socket = match relay_socket_path(&target.fingerprint) {
            Some(path) => path,
            None => {
                self.push_display_message(DisplayMessage::error(format!(
                    "Could not place a local socket for {device}."
                )));
                return false;
            }
        };

        let identity = match DeviceIdentity::load_or_create() {
            Ok(identity) => identity,
            Err(error) => {
                self.push_display_message(DisplayMessage::error(format!(
                    "This device has no identity to reach {device} with: {error}"
                )));
                return false;
            }
        };
        let credentials = match PeerCredentials::from_identity(&identity) {
            Ok(credentials) => Arc::new(credentials),
            Err(error) => {
                self.push_display_message(DisplayMessage::error(format!(
                    "Could not build credentials for {device}: {error}"
                )));
                return false;
            }
        };

        crate::transport::remove_socket(&socket);
        let listener = match crate::transport::Listener::bind(&socket) {
            Ok(listener) => listener,
            Err(error) => {
                self.push_display_message(DisplayMessage::error(format!(
                    "Could not open a local socket for {device}: {error}"
                )));
                return false;
            }
        };
        restrict_to_owner(&socket);
        spawn_relay(listener, credentials, Arc::new(target));

        // Remember where we came from before leaving, so a local session picked
        // later can bring the client back.
        let _remembered = HOME_SOCKET.set(crate::server::socket_path());

        self.workspace_client.queue_peer_switch(PeerSwitch {
            socket,
            session_id: Some(session_id),
            device: device.to_string(),
        });
        true
    }
}

/// The socket a locally-owned session has to be resumed on, or `None` when the
/// client is already there.
///
/// A local row chosen while pointed at a peer is the case that matters: the id
/// belongs to this machine's store, and sending it as-is asks the other machine
/// to resume a session it has never heard of — which is what made the move a
/// one-way door.
fn way_home<'a>(
    home: Option<&'a std::path::Path>,
    current: &std::path::Path,
) -> Option<&'a std::path::Path> {
    home.filter(|home| *home != current)
}

/// Where to reach `device`, from the trust store.
fn resolve_target(device: &str) -> Result<PeerTarget, String> {
    let trust =
        TrustStore::load().map_err(|error| format!("Could not read paired devices: {error}"))?;
    let entry = trust
        .find_by_name_or_fingerprint(device)
        .ok_or_else(|| format!("{device} is no longer a paired device."))?;
    let address = entry
        .address
        .clone()
        .ok_or_else(|| format!("{device} has no recorded address, so there is nowhere to dial."))?;
    let fingerprint = Fingerprint::from_hex(&entry.fingerprint)
        .map_err(|error| format!("{device} has an unreadable fingerprint: {error}"))?;
    Ok(PeerTarget {
        address,
        fingerprint,
    })
}

/// Named after the device so two peer sessions cannot collide, and kept well
/// away from `arterm.sock` so nothing mistakes it for the local daemon — which
/// is also what `server_is_remote_peer` keys on.
fn relay_socket_path(fingerprint: &Fingerprint) -> Option<std::path::PathBuf> {
    let short = fingerprint.to_hex().get(..16)?.to_string();
    Some(crate::storage::runtime_dir().join(format!("arterm-peer-{short}.sock")))
}

/// One TLS link per local connection: the client re-dials on every reconnect,
/// and the arterm protocol has no framing that would let two share a stream.
fn spawn_relay(
    listener: crate::transport::Listener,
    credentials: Arc<PeerCredentials>,
    target: Arc<PeerTarget>,
) {
    tokio::spawn(async move {
        #[cfg_attr(unix, allow(unused_mut))]
        let mut listener = listener;
        loop {
            let Ok((mut local, _addr)) = listener.accept().await else {
                return;
            };
            let credentials = Arc::clone(&credentials);
            let target = Arc::clone(&target);
            tokio::spawn(async move {
                if let Err(error) =
                    arterm_peer::relay_local_stream(&credentials, &target, &mut local).await
                {
                    crate::logging::warn(&format!("Peer session ended: {error:#}"));
                }
            });
        }
    });
}

/// Stricter than the daemon socket beside it: this one is a door to a different
/// machine's agent, and should not be walkable by anyone sharing this host.
fn restrict_to_owner(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            crate::logging::warn(&format!("Could not restrict {}: {error}", path.display()));
        }
    }
    #[cfg(not(unix))]
    {
        let _unused = path;
    }
}

#[cfg(test)]
#[path = "peer_switch_tests.rs"]
mod peer_switch_tests;
