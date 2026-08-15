//! Dialling a paired device.
//!
//! The mirror image of [`crate::listen`], and it applies the same two rules
//! from the other side: the destination has to be on this machine's network,
//! and the certificate that answers has to be the one this device paired with.
//! Checking the fingerprint here is what makes the invite's third field worth
//! carrying — without it, the first connection would trust whoever picked up.

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;

use crate::hello::{
    PEER_PROTOCOL_VERSION, PeerHello, PeerWelcome, RemoteServerSummary, read_line, write_line,
};
use crate::subnet;
use crate::tls::{PeerCredentials, client_config};

/// How long the far end gets to answer before this is called unreachable.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// The device to reach, and the certificate that will prove it is that device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerTarget {
    /// `host:port`.
    pub address: String,
    pub fingerprint: Fingerprint,
}

/// An authenticated connection to a peer, ready to carry arterm protocol.
#[derive(Debug)]
pub struct PeerLink {
    pub stream: TlsStream<TcpStream>,
    pub peer_name: String,
    pub peer_addr: SocketAddr,
    /// Whether this connection is the one that completed the pairing.
    pub paired_now: bool,
}

/// Connect to a paired device.
///
/// `secret` is the one-time value from the invite, present only until the first
/// successful connection has spent it. `listen_port` is this device's own peer
/// port, sent so the far end can record an address it could dial back on.
pub async fn connect_to_peer(
    credentials: &PeerCredentials,
    target: &PeerTarget,
    secret: Option<&str>,
    listen_port: Option<u16>,
) -> Result<PeerLink> {
    let (mut stream, peer_addr) = dial(credentials, target).await?;

    let hello = match secret {
        Some(secret) => PeerHello::Pair {
            version: PEER_PROTOCOL_VERSION,
            name: credentials.name().to_string(),
            secret: secret.to_string(),
            listen_port,
        },
        None => PeerHello::Session {
            version: PEER_PROTOCOL_VERSION,
            name: credentials.name().to_string(),
            listen_port,
        },
    };
    write_line(&mut stream, &hello).await?;

    // In TLS 1.3 the client finishes its handshake before the server has looked
    // at the certificate it sent, so a peer that does not trust this device
    // does not fail `connect` — it fails here, as an alert on the first read.
    // Without saying so, the user sees "received fatal alert: HandshakeFailure"
    // for the single most likely thing to be wrong.
    let welcome: PeerWelcome = timeout(CONNECT_TIMEOUT, read_line(&mut stream))
        .await
        .with_context(|| format!("{peer_addr} accepted the connection but never answered"))?
        .with_context(|| {
            format!(
                "{peer_addr} ended the connection before answering — the likeliest cause is that \
                 it has not paired with this device; run `arterm device invite` there and \
                 `arterm device join` here"
            )
        })?;

    match welcome {
        PeerWelcome::Ready { name, .. } => Ok(PeerLink {
            stream,
            peer_name: name,
            peer_addr,
            paired_now: false,
        }),
        PeerWelcome::Paired { name, .. } => Ok(PeerLink {
            stream,
            peer_name: name,
            peer_addr,
            paired_now: true,
        }),
        PeerWelcome::Sessions { .. } => {
            anyhow::bail!("{peer_addr} answered a session request with a session list")
        }
        PeerWelcome::Refused { reason } => {
            anyhow::bail!("{peer_addr} refused the connection: {reason}")
        }
    }
}

/// Ask a paired device what sessions it is running, without opening one.
///
/// This is what populates the cross-machine session list. It is a separate
/// round trip from [`connect_to_peer`] on purpose: the list is read for every
/// paired device, often, and driving a session to read it would be both
/// wasteful and visible on the far end as a connect/disconnect.
pub async fn list_peer_sessions(
    credentials: &PeerCredentials,
    target: &PeerTarget,
) -> Result<Vec<RemoteServerSummary>> {
    let (mut stream, peer_addr) = dial(credentials, target).await?;

    write_line(
        &mut stream,
        &PeerHello::List {
            version: PEER_PROTOCOL_VERSION,
            name: credentials.name().to_string(),
        },
    )
    .await?;

    let welcome: PeerWelcome = timeout(CONNECT_TIMEOUT, read_line(&mut stream))
        .await
        .with_context(|| format!("{peer_addr} accepted the connection but never answered"))?
        .with_context(|| format!("{peer_addr} ended the connection before listing its sessions"))?;

    match welcome {
        PeerWelcome::Sessions { servers, .. } => Ok(servers),
        PeerWelcome::Refused { reason } => {
            anyhow::bail!("{peer_addr} refused to list its sessions: {reason}")
        }
        PeerWelcome::Ready { .. } | PeerWelcome::Paired { .. } => {
            anyhow::bail!("{peer_addr} answered a session-list request with a session")
        }
    }
}

/// Dial a peer: resolve to a local-network address, connect, and complete the
/// mutual-TLS handshake. Shared by [`connect_to_peer`] and
/// [`list_peer_sessions`] — everything up to the first handshake line is the
/// same for both.
async fn dial(
    credentials: &PeerCredentials,
    target: &PeerTarget,
) -> Result<(TlsStream<TcpStream>, SocketAddr)> {
    let peer_addr = resolve_local_address(&target.address).await?;

    let config = client_config(credentials, target.fingerprint.clone())?;
    let connector = TlsConnector::from(Arc::new(config));

    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(peer_addr))
        .await
        .with_context(|| format!("connecting to {peer_addr} timed out"))?
        .with_context(|| format!("connecting to {peer_addr}"))?;

    // The certificate names the machine, not the address, and the verifier
    // ignores this value entirely — the fingerprint is the check. It is
    // supplied only because rustls requires a name to start a handshake.
    let server_name = ServerName::IpAddress(peer_addr.ip().into());
    let stream = timeout(CONNECT_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .with_context(|| format!("the TLS handshake with {peer_addr} timed out"))?
        .with_context(|| {
            format!(
                "the TLS handshake with {peer_addr} failed — the device there may not have this \
                 one in its trust store"
            )
        })?;
    Ok((stream, peer_addr))
}

/// Resolve `address` and keep only a destination on this machine's network.
///
/// The same-subnet rule is enforced on this side too. A listener refusing
/// off-subnet sources protects the machine being reached; this protects the
/// machine doing the reaching, whose trust store entry would otherwise happily
/// dial a paired laptop across the internet the moment its address changed.
async fn resolve_local_address(address: &str) -> Result<SocketAddr> {
    let candidates: Vec<SocketAddr> = tokio::net::lookup_host(address)
        .await
        .with_context(|| format!("looking up the address {address}"))?
        .collect();
    if candidates.is_empty() {
        anyhow::bail!("{address} does not resolve to any address");
    }

    let networks = subnet::local_networks()?;
    match candidates
        .iter()
        .find(|candidate| subnet::is_local_peer(&networks, candidate.ip()))
    {
        Some(local) => Ok(*local),
        None => anyhow::bail!(
            "{address} is not on any network this machine is on — peer sessions are restricted \
             to the local network, so connect both machines to the same one"
        ),
    }
}
