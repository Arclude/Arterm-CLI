//! Where a registered server lives.
//!
//! Until cross-machine sessions, every server in `servers.json` ran on this
//! machine and was addressed by a local socket path. That assumption is now a
//! field: a server is either [`ServerHost::Local`] (this machine, reachable at
//! its socket path) or [`ServerHost::Remote`] (a paired device, reachable over
//! the peer transport at the device's address, identified by its certificate
//! fingerprint).
//!
//! The field defaults to `Local` when absent, so a `servers.json` written before
//! this existed still loads unchanged — see the round-trip test in
//! `registry_tests.rs`. Nothing here opens a connection; the fingerprint and
//! address are the trust-store facts the peer transport later dials.

use serde::{Deserialize, Serialize};

/// The machine a [`crate::registry::ServerInfo`] runs on.
///
/// Internally tagged on `kind` so the JSON is self-describing and a new variant
/// can be added without a positional break. Old files carry no `kind` at all and
/// deserialize as [`ServerHost::Local`] via `#[serde(default)]` on the field.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerHost {
    /// Runs on this machine. Reachable at the server's local socket path; the
    /// fingerprint and address fields on the remote variant do not apply.
    #[default]
    Local,

    /// Runs on a paired device. The peer transport reaches it at `address` and
    /// verifies it against `fingerprint`; both come from the trust store, never
    /// from discovery.
    Remote {
        /// Full certificate fingerprint (hex) of the device that owns this
        /// server. Matches a `TrustedDevice::fingerprint` in the trust store.
        fingerprint: String,
        /// Last address the owning device was reached at, if known. Advisory,
        /// exactly as on `TrustedDevice::address`: a stale value means "try
        /// elsewhere", never "different device".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        address: Option<String>,
    },
}

impl ServerHost {
    /// A remote host owned by the device with this fingerprint and address.
    pub fn remote(fingerprint: impl Into<String>, address: Option<String>) -> Self {
        Self::Remote {
            fingerprint: fingerprint.into(),
            address,
        }
    }

    /// Whether this server runs on the local machine.
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }

    /// The owning device's fingerprint, when the server is remote.
    pub fn fingerprint(&self) -> Option<&str> {
        match self {
            Self::Local => None,
            Self::Remote { fingerprint, .. } => Some(fingerprint),
        }
    }

    /// The owning device's last-known address, when the server is remote and one
    /// is recorded.
    pub fn address(&self) -> Option<&str> {
        match self {
            Self::Local => None,
            Self::Remote { address, .. } => address.as_deref(),
        }
    }
}

#[cfg(test)]
#[path = "registry_host_tests.rs"]
mod registry_host_tests;
