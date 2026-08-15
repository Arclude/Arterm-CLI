//! This installation's own identity: a self-signed certificate, minted once.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// SHA-256 of the device certificate, in DER form.
///
/// Derived, never stored. Storing it would let the recorded value drift from
/// the certificate it claims to describe, and a fingerprint that disagrees with
/// its own key is worse than none: it is the value both sides compare to decide
/// whether they are talking to the right machine.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Fingerprint([u8; 32]);

impl Fingerprint {
    pub fn of_certificate(cert_der: &[u8]) -> Self {
        let digest = Sha256::digest(cert_der);
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest);
        Self(bytes)
    }

    /// Full value, as it travels in an invite and is compared on connect.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn from_hex(text: &str) -> Result<Self> {
        let raw = hex::decode(text.trim())
            .with_context(|| format!("device fingerprint is not valid hex: {text}"))?;
        let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
            anyhow::anyhow!(
                "device fingerprint must be 32 bytes, got {} — this is not an arterm fingerprint",
                raw.len()
            )
        })?;
        Ok(Self(bytes))
    }

    /// Short grouped form for reading aloud or comparing across two screens.
    ///
    /// The first 8 bytes only. Enough for a human to confirm two machines mean
    /// the same device; the full value is what is actually verified.
    pub fn to_display(&self) -> String {
        self.0[..8]
            .chunks(2)
            .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
            .collect::<Vec<_>>()
            .join("-")
    }
}

impl std::fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_display())
    }
}

impl std::fmt::Debug for Fingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Fingerprint({})", self.to_display())
    }
}

#[derive(Serialize, Deserialize)]
struct IdentityMetadata {
    name: String,
    created_at: String,
}

/// This machine's identity: the certificate it presents, and the key that
/// proves it owns that certificate.
pub struct DeviceIdentity {
    cert_pem: String,
    key_pem: String,
    cert_der: Vec<u8>,
    name: String,
}

impl DeviceIdentity {
    /// Load the stored identity, minting one on first use.
    ///
    /// Minting is a one-time event on purpose: the fingerprint is what other
    /// devices recorded when they paired, so regenerating it silently would
    /// break every existing pairing with no visible cause.
    pub fn load_or_create() -> Result<Self> {
        Self::load_or_create_in(&crate::device_dir()?)
    }

    /// Same, against an explicit directory.
    ///
    /// Exists so tests never have to move `ARTERM_HOME` out from under a
    /// process: mutating a process-global to isolate a test makes the suite
    /// order-dependent, and this crate's tests would all be fighting over the
    /// same variable.
    pub fn load_or_create_in(dir: &Path) -> Result<Self> {
        let cert_path = dir.join("device.crt");
        let key_path = dir.join("device.key");
        let meta_path = dir.join("device.json");

        if cert_path.exists() && key_path.exists() {
            return Self::load_from(&cert_path, &key_path, &meta_path);
        }
        Self::create_at(&cert_path, &key_path, &meta_path)
    }

    fn load_from(cert_path: &Path, key_path: &Path, meta_path: &Path) -> Result<Self> {
        let cert_pem = std::fs::read_to_string(cert_path)
            .with_context(|| format!("reading device certificate at {}", cert_path.display()))?;
        let key_pem = std::fs::read_to_string(key_path)
            .with_context(|| format!("reading device key at {}", key_path.display()))?;
        let cert_der = pem_to_der(&cert_pem).with_context(|| {
            format!("device certificate at {} is malformed", cert_path.display())
        })?;

        let name = match std::fs::read_to_string(meta_path) {
            Ok(raw) => serde_json::from_str::<IdentityMetadata>(&raw)
                .map(|meta| meta.name)
                .unwrap_or_else(|_| default_device_name()),
            Err(_) => default_device_name(),
        };

        Ok(Self {
            cert_pem,
            key_pem,
            cert_der,
            name,
        })
    }

    fn create_at(cert_path: &Path, key_path: &Path, meta_path: &Path) -> Result<Self> {
        let name = default_device_name();
        let mut params = rcgen::CertificateParams::new(vec![name.clone()])
            .context("building device certificate parameters")?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, name.clone());

        let key_pair = rcgen::KeyPair::generate().context("generating device key pair")?;
        let cert = params
            .self_signed(&key_pair)
            .context("self-signing the device certificate")?;

        let cert_pem = cert.pem();
        let key_pem = key_pair.serialize_pem();
        let cert_der = cert.der().to_vec();

        std::fs::write(cert_path, &cert_pem)
            .with_context(|| format!("writing device certificate to {}", cert_path.display()))?;
        write_private(key_path, &key_pem)?;

        let meta = IdentityMetadata {
            name: name.clone(),
            created_at: now_timestamp(),
        };
        let encoded = serde_json::to_string_pretty(&meta)?;
        std::fs::write(meta_path, encoded)
            .with_context(|| format!("writing device metadata to {}", meta_path.display()))?;

        Ok(Self {
            cert_pem,
            key_pem,
            cert_der,
            name,
        })
    }

    pub fn fingerprint(&self) -> Fingerprint {
        Fingerprint::of_certificate(&self.cert_der)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The certificate this device presents. Consumed by the peer transport
    /// once mutual TLS lands.
    pub fn certificate_pem(&self) -> &str {
        &self.cert_pem
    }

    /// The private key proving ownership of [`Self::certificate_pem`].
    pub fn private_key_pem(&self) -> &str {
        &self.key_pem
    }

    /// Rename the device. Only the label changes — the fingerprint other
    /// devices recorded stays as it is, so existing pairings survive.
    pub fn set_name(&mut self, name: &str) -> Result<()> {
        self.set_name_in(&crate::device_dir()?, name)
    }

    pub fn set_name_in(&mut self, dir: &Path, name: &str) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            anyhow::bail!("device name cannot be empty");
        }
        let meta_path = dir.join("device.json");
        let created_at = match std::fs::read_to_string(&meta_path) {
            Ok(raw) => serde_json::from_str::<IdentityMetadata>(&raw)
                .map(|meta| meta.created_at)
                .unwrap_or_else(|_| now_timestamp()),
            Err(_) => now_timestamp(),
        };
        let meta = IdentityMetadata {
            name: trimmed.to_string(),
            created_at,
        };
        std::fs::write(&meta_path, serde_json::to_string_pretty(&meta)?)
            .with_context(|| format!("writing device metadata to {}", meta_path.display()))?;
        self.name = trimmed.to_string();
        Ok(())
    }
}

fn write_private(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)
        .with_context(|| format!("writing device key to {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting permissions on {}", path.display()))?;
    }
    Ok(())
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    decode_base64(body.trim())
}

/// Minimal standard-alphabet base64 decoder.
///
/// Written out rather than pulling a base64 crate in for one call site: the
/// only base64 this crate meets is the body of a PEM file it just wrote.
fn decode_base64(input: &str) -> Result<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let Some(six) = value(byte) else {
            anyhow::bail!("unexpected character in base64 body");
        };
        acc = (acc << 6) | six;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

/// A human label for this machine, defaulting to its hostname.
///
/// Read from the environment rather than through a dependency: the value is a
/// display label, and a wrong guess costs a rename, not a broken pairing — the
/// fingerprint is what identifies the device.
fn default_device_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Ok(value) = std::fs::read_to_string("/etc/hostname") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "arterm-device".to_string()
}

fn now_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod identity_tests;
