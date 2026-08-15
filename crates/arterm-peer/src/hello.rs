//! One line each way, then get out of the arterm protocol's way.
//!
//! The peer handshake needs to say two things TLS cannot: which of the two
//! things this connection is (a session, or a first pairing), and — for a
//! pairing — the one-time secret from the invite. Both are exchanged as a
//! single newline-terminated JSON object in each direction, and then the stream
//! carries nothing but the ordinary newline-delimited `Request` / `ServerEvent`
//! traffic a local Unix-socket client sends.
//!
//! Reading is done a byte at a time up to the newline. That looks wasteful and
//! is not: the bytes are already decrypted in rustls' buffer, so there is no
//! extra round trip, and a buffered reader would swallow protocol bytes that
//! arrived in the same TLS record — which then have to be handed to the splice
//! by some other route, or are silently lost.

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Wire format version, so two machines on different arterm builds fail with a
/// sentence instead of a parse error halfway through a session.
pub const PEER_PROTOCOL_VERSION: u32 = 1;

/// Longest handshake line accepted. A real one is a couple of hundred bytes;
/// the cap is what stops a peer that has passed the fingerprint check from
/// making the listener buffer without limit.
pub const MAX_HELLO_BYTES: usize = 4096;

/// What the connecting device asks for.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerHello {
    /// Drive a session. Sent by a device that is already paired.
    Session {
        version: u32,
        name: String,
        /// Port this device accepts peer connections on, so the far end can
        /// record an address it can dial back on rather than guessing one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        listen_port: Option<u16>,
    },
    /// First contact: present the one-time secret from the invite.
    Pair {
        version: u32,
        name: String,
        secret: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        listen_port: Option<u16>,
    },
}

impl PeerHello {
    pub fn version(&self) -> u32 {
        match self {
            Self::Session { version, .. } | Self::Pair { version, .. } => *version,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Session { name, .. } | Self::Pair { name, .. } => name,
        }
    }

    pub fn listen_port(&self) -> Option<u16> {
        match self {
            Self::Session { listen_port, .. } | Self::Pair { listen_port, .. } => *listen_port,
        }
    }
}

/// What the accepting device answers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PeerWelcome {
    /// Already paired. Everything after this line is the arterm protocol.
    Ready { version: u32, name: String },
    /// Pairing completed and recorded. Everything after this line is the
    /// arterm protocol, on the same connection — a second dial would prove
    /// nothing the secret has not already proved.
    Paired { version: u32, name: String },
    /// Nothing further will be read from this connection.
    Refused { reason: String },
}

impl PeerWelcome {
    pub fn peer_name(&self) -> Option<&str> {
        match self {
            Self::Ready { name, .. } | Self::Paired { name, .. } => Some(name),
            Self::Refused { .. } => None,
        }
    }
}

/// Send one JSON object followed by a newline.
pub async fn write_line<W, T>(writer: &mut W, value: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut encoded = serde_json::to_vec(value).context("encoding a peer handshake line")?;
    encoded.push(b'\n');
    writer
        .write_all(&encoded)
        .await
        .context("sending a peer handshake line")?;
    writer
        .flush()
        .await
        .context("flushing a peer handshake line")
}

/// Read one newline-terminated JSON object, and not a byte more.
pub async fn read_line<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut line = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let read = reader
            .read(&mut byte)
            .await
            .context("reading a peer handshake line")?;
        if read == 0 {
            anyhow::bail!("the peer closed the connection before finishing its handshake line");
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= MAX_HELLO_BYTES {
            anyhow::bail!(
                "the peer sent more than {MAX_HELLO_BYTES} bytes without ending its handshake line"
            );
        }
        line.push(byte[0]);
    }
    serde_json::from_slice(&line).context("this does not look like an arterm peer handshake")
}

#[cfg(test)]
#[path = "hello_tests.rs"]
mod hello_tests;
