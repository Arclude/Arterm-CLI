//! The devices this installation will accept a connection from.
//!
//! Empty until something is added on purpose. Nothing is trusted because it is
//! reachable, on the same network, or announcing itself — being discoverable
//! and being trusted are separate facts, and only the second one grants a peer
//! the ability to drive an agent on this machine.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::identity::Fingerprint;

/// A device that has been paired with this one.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrustedDevice {
    /// Full certificate fingerprint, hex. The identity that is actually
    /// verified on connect.
    pub fingerprint: String,
    /// Human label, taken from the peer at pairing time. Display only.
    pub name: String,
    /// Last address this device was reached at, if one is known.
    ///
    /// Advisory: a device keeps its identity when its address changes, so a
    /// stale value here means "try elsewhere", never "different device".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    pub paired_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    devices: Vec<TrustedDevice>,
}

#[derive(Debug)]
pub struct TrustStore {
    path: PathBuf,
    devices: Vec<TrustedDevice>,
}

impl TrustStore {
    pub fn load() -> Result<Self> {
        Self::load_at(crate::device_dir()?.join("trusted.json"))
    }

    /// Same, against an explicit file, so tests need no process-global state.
    pub fn load_at(path: PathBuf) -> Result<Self> {
        let devices =
            match std::fs::read_to_string(&path) {
                Ok(raw) => serde_json::from_str::<TrustFile>(&raw)
                    .with_context(|| {
                        format!(
                            "trust store at {} is malformed; refusing to start from an empty one \
                             so a damaged file is never silently treated as 'trusts nobody'",
                            path.display()
                        )
                    })?
                    .devices,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("reading the trust store at {}", path.display()));
                }
            };
        Ok(Self { path, devices })
    }

    pub fn devices(&self) -> &[TrustedDevice] {
        &self.devices
    }

    pub fn find(&self, fingerprint: &Fingerprint) -> Option<&TrustedDevice> {
        let hex = fingerprint.to_hex();
        self.devices.iter().find(|device| device.fingerprint == hex)
    }

    /// Record a device as trusted, replacing any earlier entry for the same
    /// fingerprint.
    ///
    /// Keyed on the fingerprint rather than the name: two machines may share a
    /// hostname, and letting a name collision overwrite a pairing would hand
    /// one device the other's trust.
    pub fn trust(&mut self, device: TrustedDevice) -> Result<()> {
        self.devices
            .retain(|existing| existing.fingerprint != device.fingerprint);
        self.devices.push(device);
        self.save()
    }

    /// Remove a device by fingerprint or by name, returning what was removed.
    pub fn forget(&mut self, needle: &str) -> Result<Option<TrustedDevice>> {
        let needle = needle.trim();
        let found = self
            .devices
            .iter()
            .position(|device| {
                device.fingerprint == needle
                    || device.name == needle
                    || device.fingerprint.starts_with(needle) && needle.len() >= 8
            })
            .map(|index| self.devices.remove(index));
        if found.is_some() {
            self.save()?;
        }
        Ok(found)
    }

    fn save(&self) -> Result<()> {
        let file = TrustFile {
            devices: self.devices.clone(),
        };
        let encoded = serde_json::to_string_pretty(&file)?;
        std::fs::write(&self.path, encoded)
            .with_context(|| format!("writing the trust store to {}", self.path.display()))
    }
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod trust_tests;
