//! Who this machine is, which machines it trusts, and how that trust is
//! established.
//!
//! Three pieces, deliberately separate:
//!
//! - [`identity`] — this installation's own keypair, minted once and never
//!   rotated silently. Its fingerprint is the device's name on the wire.
//! - [`trust`] — the devices this one will accept a connection from. Empty by
//!   default; nothing is trusted implicitly.
//! - [`invite`] — the one-time code that turns "a device on the network" into
//!   "a device I trust", carrying the address, a short-lived secret, and the
//!   inviter's fingerprint.
//!
//! No network code lives here. This crate answers identity questions offline so
//! the peer transport can be built on top of a trust decision that is already
//! made.
//!
//! # Relationship to gateway pairing
//!
//! `arterm-base`'s gateway registry also pairs devices, and the two are
//! deliberately separate rather than accidentally duplicated. They answer
//! different questions:
//!
//! - The **gateway** admits *client* devices — an iOS app or a browser reaching
//!   a machine to drive its sessions. It authenticates with a bearer token over
//!   the WebSocket it already speaks.
//! - This crate identifies a *machine* to another machine, symmetrically: both
//!   ends hold a certificate, and each decides whether it will accept the other.
//!   The certificate exists because the peer transport authenticates with mutual
//!   TLS, which a bearer token cannot do.
//!
//! Practical consequence: revoking a phone is `arterm pair --revoke`, revoking a
//! machine is `arterm device forget`. Neither store is authoritative over the
//! other, and nothing here reads or writes the gateway's registry.

pub mod identity;
pub mod invite;
pub mod trust;

pub use identity::{DeviceIdentity, Fingerprint};
pub use invite::Invite;
pub use trust::{TrustStore, TrustedDevice};

/// Directory holding this installation's identity and trust state.
///
/// Owner-only: it contains a private key, and a readable key is the whole
/// security model gone.
pub fn device_dir() -> anyhow::Result<std::path::PathBuf> {
    let dir = arterm_storage::arterm_dir()?.join("device");
    std::fs::create_dir_all(&dir)?;
    arterm_core::fs::set_directory_permissions_owner_only(&dir)?;
    Ok(dir)
}
