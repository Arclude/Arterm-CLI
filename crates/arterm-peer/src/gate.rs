//! The trust decision, as the handshake needs it.
//!
//! [`arterm_device::TrustStore`] and [`arterm_device::invite::PendingInvites`]
//! each answer half the question. This joins them into the single verdict a
//! TLS handshake can act on, and owns the one subtle case: a device nobody has
//! paired with yet, arriving while this machine is holding an invite open.
//!
//! Every call reads from disk. That is deliberate and not an oversight about
//! caching: `arterm device forget` must take effect on the next connection, not
//! on the next restart of a listener that may have been up for days. The cost
//! is two small file reads per handshake, against a peer connection that is
//! about to open a TLS session.

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use arterm_device::invite::PendingInvites;
use arterm_device::{TrustStore, TrustedDevice};
use std::path::{Path, PathBuf};

/// What this machine will let an arriving certificate do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Admission {
    /// Paired already. May open a session.
    Trusted(TrustedDevice),
    /// Not paired, but this machine is currently inviting, so the certificate
    /// may connect far enough to present a one-time secret — and no further.
    /// Nothing is recorded until that secret checks out.
    PairingWindow,
    /// Not paired and not invited. The handshake ends here.
    Refused,
}

/// Reads the trust store and the pending invites to answer one question.
#[derive(Clone, Debug)]
pub struct TrustGate {
    trust_path: PathBuf,
    invites_path: PathBuf,
}

impl TrustGate {
    /// The gate for this installation.
    pub fn for_this_device() -> Result<Self> {
        Ok(Self::in_dir(&arterm_device::device_dir()?))
    }

    /// Same, against an explicit directory, so tests need no process-global
    /// state — the same reason `DeviceIdentity::load_or_create_in` exists.
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            trust_path: dir.join("trusted.json"),
            invites_path: dir.join("invites.json"),
        }
    }

    /// What an arriving certificate is allowed to do.
    pub fn admits(&self, fingerprint: &Fingerprint) -> Result<Admission> {
        let trust = TrustStore::load_at(self.trust_path.clone())
            .context("reading the trust store to decide whether to admit a peer")?;
        if let Some(device) = trust.find(fingerprint) {
            return Ok(Admission::Trusted(device.clone()));
        }

        let invites = PendingInvites::load_at(self.invites_path.clone())
            .context("reading pending invites to decide whether to admit a peer")?;
        if invites.has_live() {
            return Ok(Admission::PairingWindow);
        }
        Ok(Admission::Refused)
    }

    /// Spend an invite secret, returning whether it was live and unspent.
    ///
    /// Single use: a secret that returns `true` here will return `false` on
    /// every later call, so a captured invite buys one pairing attempt and not
    /// a standing key.
    pub fn consume_secret(&self, secret: &str) -> Result<bool> {
        let mut invites = PendingInvites::load_at(self.invites_path.clone())
            .context("reading pending invites to spend a pairing secret")?;
        invites.consume(secret)
    }

    /// Update where an already-paired device was last reached, leaving the rest
    /// of its entry alone.
    ///
    /// Separate from [`Self::record_pairing`] because that one stamps
    /// `paired_at`, and a device reconnecting is not a device pairing again —
    /// running the two together would show the last connection time under a
    /// field labelled "paired".
    ///
    /// A device that is no longer in the store is left out of it: it was
    /// forgotten between the handshake and this call, and re-adding it would
    /// undo that.
    pub fn record_address(&self, fingerprint: &Fingerprint, address: String) -> Result<()> {
        let mut trust = TrustStore::load_at(self.trust_path.clone())
            .context("reading the trust store to refresh a peer's address")?;
        let Some(existing) = trust.find(fingerprint) else {
            return Ok(());
        };
        let updated = TrustedDevice {
            address: Some(address),
            ..existing.clone()
        };
        trust.trust(updated)
    }

    /// Learn a trusted peer's real device name from its handshake hello.
    ///
    /// Only overwrites the stored name when the stored one looks like a
    /// placeholder captured from an address at pairing time (legacy entries
    /// like `192.168.1.108:7644` from `device join` without `--name`). A name
    /// the user chose explicitly is never second-guessed.
    ///
    /// Returns the name now stored for the device (learned or kept), so the
    /// caller can use the current identity without re-reading the store.
    /// Like [`Self::record_address`], a device that is no longer in the store
    /// is left out of it.
    pub fn record_name(&self, fingerprint: &Fingerprint, name: &str) -> Result<String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Ok(self
                .stored_name(fingerprint)
                .context("reading the trust store to learn a peer's name")?
                .unwrap_or_default());
        }
        let mut trust = TrustStore::load_at(self.trust_path.clone())
            .context("reading the trust store to learn a peer's name")?;
        let Some(existing) = trust.find(fingerprint) else {
            return Ok(String::new());
        };
        if existing.name == trimmed || !name_looks_like_address(&existing.name) {
            return Ok(existing.name.clone());
        }
        let updated = TrustedDevice {
            name: trimmed.to_string(),
            ..existing.clone()
        };
        let name = updated.name.clone();
        trust.trust(updated)?;
        Ok(name)
    }

    /// The name currently stored for a fingerprint, if the device is trusted.
    fn stored_name(&self, fingerprint: &Fingerprint) -> Result<Option<String>> {
        let trust = TrustStore::load_at(self.trust_path.clone())
            .context("reading the trust store to look up a peer's name")?;
        Ok(trust.find(fingerprint).map(|device| device.name.clone()))
    }

    /// Record a device this machine has just finished pairing with.
    pub fn record_pairing(
        &self,
        fingerprint: &Fingerprint,
        name: &str,
        address: Option<String>,
    ) -> Result<()> {
        let mut trust = TrustStore::load_at(self.trust_path.clone())
            .context("reading the trust store to record a new pairing")?;
        trust.trust(TrustedDevice {
            fingerprint: fingerprint.to_hex(),
            name: name.to_string(),
            address,
            paired_at: chrono::Utc::now().to_rfc3339(),
        })
    }
}

/// Whether a stored device name looks like it was captured from a network
/// address rather than chosen: `192.168.1.108:7644`, `[fe80::1]:7644`, or a
/// bare host/IP with or without a port. Used to decide when a learned name
/// from the wire may replace it.
fn name_looks_like_address(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Exact SocketAddr forms first: covers IPv4 `host:port`, IPv6
    // `[v6]:port`, and bare `[v6]`.
    if trimmed.parse::<std::net::SocketAddr>().is_ok() {
        return true;
    }
    if trimmed.starts_with('[') {
        // Bracketed but not a full SocketAddr (missing port, scope id, ...).
        return trimmed
            .trim_start_matches('[')
            .split(']')
            .next()
            .is_some_and(|host| host.parse::<std::net::Ipv6Addr>().is_ok() || host.contains(':'));
    }
    // `host:port` where the port half parses: an IPv4 socket form or a
    // hostname:port invite address. Unbracketed IPv6 also lands here and is
    // not a plausible user-chosen name either.
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        return !host.is_empty() && port.parse::<u16>().is_ok();
    }
    // Bare IP (v4 or unbracketed v6) or bare hostname-with-dots that came from
    // an invite address. A dotted name like "toygar-pc" has no dots, and a
    // genuine device name with dots is rare enough that the learned name from
    // the wire is the better identity anyway.
    trimmed.parse::<std::net::IpAddr>().is_ok() || (!trimmed.contains(' ') && trimmed.contains('.'))
}

#[cfg(test)]
#[path = "gate_tests.rs"]
mod gate_tests;
