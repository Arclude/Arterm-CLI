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
    LineError, MAX_SESSION_LIST_BYTES, MAX_SESSION_LIST_PAGES, PEER_PROTOCOL_VERSION, PeerHello,
    PeerWelcome, RemoteServerSummary, SessionPage, merge_session_pages, read_line,
    read_line_with_limit, total_sessions, write_line,
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

/// Why listing a peer's sessions failed, split by whether anyone should hear
/// about it.
///
/// The cross-machine list is built to expect unreachable devices: a laptop that
/// is asleep, off this network, or simply not listening contributes no rows and
/// no noise, and a reader is not meant to be able to tell it from an idle one.
/// Everything else — a reply that will not parse, one longer than the reader
/// accepts, a refusal — is a fault, and reporting it as "no sessions" is what
/// kept a 4 KiB cap on the session list invisible for as long as it was.
#[derive(Debug)]
pub enum PeerListError {
    /// Nothing answered at that address, or the connection died before the
    /// answer did. Expected, and quiet by design.
    Unreachable(anyhow::Error),
    /// The device answered and the answer could not be used.
    Unusable(anyhow::Error),
}

impl PeerListError {
    /// Whether this is the expected "that machine is not there" case.
    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    /// The wrapped cause, whichever kind this is.
    pub fn cause(&self) -> &anyhow::Error {
        match self {
            Self::Unreachable(error) | Self::Unusable(error) => error,
        }
    }
}

impl std::fmt::Display for PeerListError {
    /// The full chain either way, for the reason [`LineError`] gives: the
    /// detail that names the fault is the whole point of keeping this typed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.cause())
    }
}

impl std::error::Error for PeerListError {}

/// Ask a paired device what sessions it is running, without opening one.
///
/// This is what populates the cross-machine session list. It is a separate
/// round trip from [`connect_to_peer`] on purpose: the list is read for every
/// paired device, often, and driving a session to read it would be both
/// wasteful and visible on the far end as a connect/disconnect.
///
/// A long list arrives a page at a time, all on the one connection this opens.
/// Each reply says whether another page is waiting; a peer that predates
/// pagination never says so, and its single reply is the whole answer — which
/// is why the reply is read under [`MAX_SESSION_LIST_BYTES`] rather than a
/// handshake's limit. That larger cap is what makes an old peer's one enormous
/// line readable at all.
pub async fn list_peer_sessions(
    credentials: &PeerCredentials,
    target: &PeerTarget,
) -> Result<Vec<RemoteServerSummary>, PeerListError> {
    let (mut stream, peer_addr) = dial(credentials, target)
        .await
        .map_err(PeerListError::Unreachable)?;

    let mut collected: Vec<RemoteServerSummary> = Vec::new();
    let mut offset = 0usize;
    for _page in 0..MAX_SESSION_LIST_PAGES {
        write_line(
            &mut stream,
            &PeerHello::List {
                version: PEER_PROTOCOL_VERSION,
                name: credentials.name().to_string(),
                page: Some(SessionPage::at(offset)),
            },
        )
        .await
        .map_err(PeerListError::Unreachable)?;

        let welcome = read_session_page(&mut stream, peer_addr).await?;
        let (servers, more) = match welcome {
            PeerWelcome::Sessions { servers, more, .. } => (servers, more),
            PeerWelcome::Refused { reason } => {
                return Err(PeerListError::Unusable(anyhow::anyhow!(
                    "{peer_addr} refused to list its sessions: {reason}"
                )));
            }
            PeerWelcome::Ready { .. } | PeerWelcome::Paired { .. } => {
                return Err(PeerListError::Unusable(anyhow::anyhow!(
                    "{peer_addr} answered a session-list request with a session"
                )));
            }
        };

        let received = total_sessions(&servers);
        merge_session_pages(&mut collected, servers);
        if !more {
            return Ok(collected);
        }
        if received == 0 {
            // "There is more" and nothing sent is a peer that would keep this
            // loop asking for the same page forever.
            return Err(PeerListError::Unusable(anyhow::anyhow!(
                "{peer_addr} says more sessions follow but sent none, so there is no page to ask \
                 for next"
            )));
        }
        offset += received;
    }

    Err(PeerListError::Unusable(anyhow::anyhow!(
        "{peer_addr} still had more sessions after {MAX_SESSION_LIST_PAGES} pages, which is more \
         than any machine lists — treating it as a fault rather than reading without limit"
    )))
}

/// Read one page of a session list, under the data cap rather than the
/// handshake cap, and say which kind of failure it was.
async fn read_session_page<S>(
    stream: &mut S,
    peer_addr: SocketAddr,
) -> Result<PeerWelcome, PeerListError>
where
    S: tokio::io::AsyncRead + Unpin,
{
    let read = read_line_with_limit::<_, PeerWelcome>(stream, MAX_SESSION_LIST_BYTES);
    match timeout(CONNECT_TIMEOUT, read).await {
        Err(_elapsed) => Err(PeerListError::Unreachable(anyhow::anyhow!(
            "{peer_addr} accepted the connection but never answered"
        ))),
        Ok(Ok(welcome)) => Ok(welcome),
        Ok(Err(LineError::Transport(error))) => Err(PeerListError::Unreachable(error.context(
            format!("{peer_addr} ended the connection before listing its sessions"),
        ))),
        Ok(Err(LineError::Protocol(error))) => Err(PeerListError::Unusable(error.context(
            format!("{peer_addr} sent a session list that cannot be read"),
        ))),
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

/// Splice one already-accepted local stream onto a fresh link to the peer.
///
/// The accept loop stays with the caller because the listener type differs by
/// caller — the CLI serves a Unix socket or named pipe, and a client that wants
/// to reach a peer without leaving its process may not listen at all. What must
/// not differ, and so lives here, is dialling the peer and moving the bytes.
///
/// One link per local connection, deliberately: the arterm protocol has no
/// framing that would let two clients share a single TLS stream, and a client
/// re-dials on every reconnect.
pub async fn relay_local_stream<S>(
    credentials: &PeerCredentials,
    target: &PeerTarget,
    local: &mut S,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + ?Sized,
{
    let link = connect_to_peer(credentials, target, None, None)
        .await
        .with_context(|| format!("reaching {}", target.address))?;
    let mut remote = link.stream;
    match tokio::io::copy_bidirectional(local, &mut remote).await {
        Ok(_) => Ok(()),
        // A session that ends is a disconnect, not a failure: whichever side
        // hangs up first, the other sees a reset rather than a clean EOF.
        Err(error) if is_ordinary_disconnect(&error) => Ok(()),
        Err(error) => Err(error).context("relaying the peer session"),
    }
}

/// Whether an I/O error is just the other end going away.
pub fn is_ordinary_disconnect(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::NotConnected
    )
}
