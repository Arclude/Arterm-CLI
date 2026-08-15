//! The one-time code that turns a reachable device into a trusted one.
//!
//! An invite carries three things and needs all three:
//!
//! - the **address**, so the joiner knows where to connect;
//! - a **one-time secret**, so the inviter can tell the intended joiner from
//!   anyone else who reaches the port;
//! - the inviter's **fingerprint**, so the joiner verifies who answered rather
//!   than trusting whoever happens to pick up. Without it the first connection
//!   is trust-on-first-use, and a machine sitting in the middle of it is
//!   indistinguishable from the real one.
//!
//! Short-lived and single-use on purpose: a leaked invite should cost a window
//! of minutes, not a standing key that grants pairing forever.

use anyhow::{Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::identity::Fingerprint;

/// How long a freshly minted invite stays valid.
pub const INVITE_LIFETIME_SECS: i64 = 10 * 60;

const SCHEME: &str = "arterm://";

/// A pairing invite, in the form it is copied between machines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invite {
    /// `host:port` the joiner should connect to.
    pub address: String,
    /// The inviting device's certificate fingerprint.
    pub fingerprint: Fingerprint,
    /// One-time secret, hex.
    pub secret: String,
}

/// An invite this device has issued and is still willing to honour.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingInvite {
    pub secret: String,
    pub address: String,
    pub expires_at: String,
}

impl Invite {
    /// Mint a new invite for this device.
    pub fn mint(address: &str, fingerprint: Fingerprint) -> Result<Self> {
        let address = address.trim();
        if address.is_empty() {
            anyhow::bail!("an invite needs an address the other device can reach");
        }
        let mut secret = [0u8; 16];
        rand::rng().fill_bytes(&mut secret);
        Ok(Self {
            address: address.to_string(),
            fingerprint,
            secret: hex::encode(secret),
        })
    }

    /// Render as the single string that gets copied to the other machine.
    pub fn to_token(&self) -> String {
        format!(
            "{SCHEME}{}#{}.{}",
            self.address,
            self.fingerprint.to_hex(),
            self.secret
        )
    }

    /// Parse a token produced by [`Self::to_token`].
    ///
    /// Every failure names the part that was wrong. A pasted invite is the one
    /// string a user types by hand in this whole flow, and "invalid invite" for
    /// a truncated paste sends them looking in the wrong place.
    pub fn parse(token: &str) -> Result<Self> {
        let token = token.trim();
        let body = token.strip_prefix(SCHEME).ok_or_else(|| {
            anyhow::anyhow!("an invite starts with `{SCHEME}` — this does not look like one")
        })?;
        let (address, rest) = body.split_once('#').ok_or_else(|| {
            anyhow::anyhow!("invite is missing the part after `#`; it may have been cut short")
        })?;
        let (fingerprint, secret) = rest.split_once('.').ok_or_else(|| {
            anyhow::anyhow!("invite is missing its secret; it may have been cut short")
        })?;

        if address.trim().is_empty() {
            anyhow::bail!("invite carries no address");
        }
        if secret.trim().is_empty() {
            anyhow::bail!("invite carries no secret");
        }
        let fingerprint = Fingerprint::from_hex(fingerprint)
            .context("the fingerprint in this invite is not a valid one")?;

        Ok(Self {
            address: address.to_string(),
            fingerprint,
            secret: secret.to_string(),
        })
    }
}

/// Invites this device has issued, pruned of anything expired.
#[derive(Debug)]
pub struct PendingInvites {
    path: std::path::PathBuf,
    invites: Vec<PendingInvite>,
}

impl PendingInvites {
    pub fn load() -> Result<Self> {
        Self::load_at(crate::device_dir()?.join("invites.json"))
    }

    /// Same, against an explicit file, so tests need no process-global state.
    pub fn load_at(path: std::path::PathBuf) -> Result<Self> {
        let invites = match std::fs::read_to_string(&path) {
            // Nothing but this crate writes this file, so a damaged one means
            // a bug or a damaged disk -- worth saying out loud rather than
            // continuing as if no invite had ever been issued. Same call as
            // the trust store makes, for the same reason.
            Ok(raw) => serde_json::from_str::<Vec<PendingInvite>>(&raw).with_context(|| {
                format!(
                    "pending invites at {} are malformed; remove the file to start clean",
                    path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reading pending invites at {}", path.display()));
            }
        };
        let mut store = Self { path, invites };
        store.prune()?;
        Ok(store)
    }

    pub fn record(&mut self, invite: &Invite) -> Result<()> {
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(INVITE_LIFETIME_SECS);
        self.invites.push(PendingInvite {
            secret: invite.secret.clone(),
            address: invite.address.clone(),
            expires_at: expires_at.to_rfc3339(),
        });
        self.save()
    }

    pub fn active(&self) -> &[PendingInvite] {
        &self.invites
    }

    /// Whether this device is currently inviting anyone.
    ///
    /// The peer listener asks this before it will let an unrecognised
    /// certificate finish a handshake. Pruning happens at load, so anything
    /// still here has an open window.
    pub fn has_live(&self) -> bool {
        !self.invites.is_empty()
    }

    /// Spend a secret, returning whether it was live and unspent.
    ///
    /// Removing on success is what makes an invite single-use: the second
    /// device to present the same secret gets `false`, whether it is a replay
    /// on the wire or the same person pasting the token twice.
    pub fn consume(&mut self, secret: &str) -> Result<bool> {
        let secret = secret.trim();
        let found = self
            .invites
            .iter()
            .position(|invite| secrets_match(&invite.secret, secret));
        match found {
            Some(index) => {
                self.invites.remove(index);
                self.save()?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Drop invites whose window has closed.
    ///
    /// An unparseable timestamp counts as expired: the safe reading of "I
    /// cannot tell when this stops being valid" is that it already has.
    fn prune(&mut self) -> Result<()> {
        let now = chrono::Utc::now();
        let before = self.invites.len();
        self.invites.retain(|invite| {
            chrono::DateTime::parse_from_rfc3339(&invite.expires_at)
                .map(|expiry| expiry > now)
                .unwrap_or(false)
        });
        if self.invites.len() != before {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let encoded = serde_json::to_string_pretty(&self.invites)?;
        std::fs::write(&self.path, encoded)
            .with_context(|| format!("writing pending invites to {}", self.path.display()))
    }
}

/// Compare two secrets without letting the comparison time say how much of the
/// guess was right.
///
/// The secret is 128 random bits, so a timing oracle is not the likeliest way
/// in — but it is checked by a network listener against attacker-supplied
/// input, which is exactly the shape where `==` on a byte string is worth not
/// writing.
fn secrets_match(stored: &str, offered: &str) -> bool {
    let stored = stored.as_bytes();
    let offered = offered.as_bytes();
    if stored.len() != offered.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in stored.iter().zip(offered.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

#[cfg(test)]
#[path = "invite_tests.rs"]
mod invite_tests;
