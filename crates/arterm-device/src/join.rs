//! The other half of an invite: the secret the *joining* device is holding.
//!
//! [`crate::invite::PendingInvites`] is what the inviter keeps — the secrets it
//! will honour. This is what the joiner keeps — the secret it will present, once,
//! the first time it reaches that device. Two files rather than one because the
//! two roles are not symmetric: the inviter must be able to refuse a spent
//! secret, and the joiner must be able to find the right secret for the address
//! it is dialling.
//!
//! Stored beside the private key in the owner-only device directory, because a
//! live secret is worth roughly what a password is worth for as long as it
//! lasts. Its own expiry is measured from the moment `device join` ran, which
//! can be later than the inviter's window opened — that asymmetry is harmless,
//! since only the inviter's copy decides whether a secret is still good.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::identity::Fingerprint;
use crate::invite::{INVITE_LIFETIME_SECS, Invite};

/// A secret this device is holding to present on first connect.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingJoin {
    /// Fingerprint of the device that issued the invite, hex.
    pub fingerprint: String,
    /// Address the invite pointed at.
    pub address: String,
    pub secret: String,
    pub expires_at: String,
}

/// Secrets awaiting a first connection, pruned of anything expired.
#[derive(Debug)]
pub struct PendingJoins {
    path: PathBuf,
    joins: Vec<PendingJoin>,
}

impl PendingJoins {
    pub fn load() -> Result<Self> {
        Self::load_at(crate::device_dir()?.join("joins.json"))
    }

    /// Same, against an explicit file, so tests need no process-global state.
    pub fn load_at(path: PathBuf) -> Result<Self> {
        let joins = match std::fs::read_to_string(&path) {
            // Same call the trust store and the invite store make: nothing but
            // this crate writes the file, so a damaged one is a bug worth
            // saying out loud rather than silently becoming "no secrets held".
            Ok(raw) => serde_json::from_str::<Vec<PendingJoin>>(&raw).with_context(|| {
                format!(
                    "pending joins at {} are malformed; remove the file and re-run \
                     `arterm device join` with a fresh invite",
                    path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reading pending joins at {}", path.display()));
            }
        };
        let mut store = Self { path, joins };
        store.prune()?;
        Ok(store)
    }

    /// Hold on to the secret in `invite` so the first connection can present it.
    ///
    /// Replaces any earlier secret for the same device: re-running
    /// `device join` with a fresh invite should supersede the stale one rather
    /// than leave two, only one of which the other end will still honour.
    pub fn record(&mut self, invite: &Invite) -> Result<()> {
        let fingerprint = invite.fingerprint.to_hex();
        self.joins.retain(|join| join.fingerprint != fingerprint);
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(INVITE_LIFETIME_SECS);
        self.joins.push(PendingJoin {
            fingerprint,
            address: invite.address.clone(),
            secret: invite.secret.clone(),
            expires_at: expires_at.to_rfc3339(),
        });
        self.save()
    }

    /// The secret held for `fingerprint`, if one is still within its window.
    pub fn secret_for(&self, fingerprint: &Fingerprint) -> Option<&str> {
        let hex = fingerprint.to_hex();
        self.joins
            .iter()
            .find(|join| join.fingerprint == hex)
            .map(|join| join.secret.as_str())
    }

    /// The address the invite for `fingerprint` pointed at, if one is held.
    pub fn address_for(&self, fingerprint: &Fingerprint) -> Option<&str> {
        let hex = fingerprint.to_hex();
        self.joins
            .iter()
            .find(|join| join.fingerprint == hex)
            .map(|join| join.address.as_str())
    }

    /// Drop the secret for `fingerprint` once the pairing is done with it.
    pub fn clear(&mut self, fingerprint: &Fingerprint) -> Result<()> {
        let hex = fingerprint.to_hex();
        let before = self.joins.len();
        self.joins.retain(|join| join.fingerprint != hex);
        if self.joins.len() != before {
            self.save()?;
        }
        Ok(())
    }

    pub fn active(&self) -> &[PendingJoin] {
        &self.joins
    }

    /// Drop secrets whose window has closed.
    ///
    /// An unparseable timestamp counts as expired, the same reading
    /// `PendingInvites` takes: "I cannot tell when this stops being valid"
    /// safely means it already has.
    fn prune(&mut self) -> Result<()> {
        let now = chrono::Utc::now();
        let before = self.joins.len();
        self.joins.retain(|join| {
            chrono::DateTime::parse_from_rfc3339(&join.expires_at)
                .map(|expiry| expiry > now)
                .unwrap_or(false)
        });
        if self.joins.len() != before {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let encoded = serde_json::to_string_pretty(&self.joins)?;
        std::fs::write(&self.path, encoded)
            .with_context(|| format!("writing pending joins to {}", self.path.display()))?;
        write_owner_only(&self.path)
    }
}

/// Restrict the file to its owner: it holds live pairing secrets.
fn write_owner_only(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _unused = path;
    }
    Ok(())
}

#[cfg(test)]
#[path = "join_tests.rs"]
mod join_tests;
