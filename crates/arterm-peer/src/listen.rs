//! Accepting a peer: subnet first, then the certificate, then the secret.
//!
//! Split into two steps on purpose. [`PeerListener::accept`] does only what
//! must happen in the accept loop — take the connection and apply the
//! same-subnet rule before a single TLS byte moves. [`PeerAdmitter::establish`]
//! does the handshake, and is cheap to clone into a spawned task so one peer
//! stalling mid-handshake cannot hold the door shut for everyone behind it.

use anyhow::{Context, Result};
use arterm_device::identity::Fingerprint;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

use crate::gate::{Admission, TrustGate};
use crate::hello::{PEER_PROTOCOL_VERSION, PeerHello, PeerWelcome, read_line, write_line};
use crate::subnet::{self, SubnetPolicy};
use crate::tls::{PeerCredentials, peer_fingerprint, server_config};

/// How long a peer gets to finish its half of the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a connection was turned away.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RejectionReason {
    /// The source address is not on any network this machine is on.
    OutsideSubnet,
    /// The TLS handshake failed. An unpaired certificate lands here — the
    /// client verifier refuses it, and rustls turns that into a handshake
    /// error, which is the whole point of doing the check there.
    Handshake(String),
    /// The handshake line was unreadable, or arrived from a build speaking a
    /// different version.
    Hello(String),
    /// A device with no pairing connected while an invite was open, but did not
    /// present a secret.
    PairingExpected,
    /// The secret presented was wrong, expired, or already spent.
    SecretRefused,
    /// The pairing was withdrawn between the handshake and the handshake line.
    NoLongerTrusted,
}

impl std::fmt::Display for RejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OutsideSubnet => write!(f, "source address is not on this machine's network"),
            Self::Handshake(detail) => write!(f, "TLS handshake failed: {detail}"),
            Self::Hello(detail) => write!(f, "handshake line rejected: {detail}"),
            Self::PairingExpected => write!(f, "device is not paired and offered no invite secret"),
            Self::SecretRefused => write!(f, "invite secret was not live and unspent"),
            Self::NoLongerTrusted => write!(f, "device stopped being trusted mid-handshake"),
        }
    }
}

/// A connection that was turned away, and where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    pub peer_addr: SocketAddr,
    pub reason: RejectionReason,
}

/// A connection past the subnet rule, not yet past anything else.
#[derive(Debug)]
pub struct PendingPeer {
    stream: TcpStream,
    peer_addr: SocketAddr,
}

impl PendingPeer {
    pub fn peer_addr(&self) -> SocketAddr {
        self.peer_addr
    }
}

/// What came off the accept loop.
#[derive(Debug)]
pub enum Arrival {
    Pending(PendingPeer),
    Rejected(Rejection),
}

/// An authenticated peer, with the stream ready to carry arterm protocol.
#[derive(Debug)]
pub struct PeerSession {
    pub stream: TlsStream<TcpStream>,
    pub fingerprint: Fingerprint,
    pub peer_name: String,
    pub peer_addr: SocketAddr,
    /// Whether this connection is the one that completed the pairing.
    pub paired_now: bool,
}

/// What came out of the handshake.
#[derive(Debug)]
pub enum Admitted {
    Session(Box<PeerSession>),
    Rejected(Rejection),
}

/// The handshake half of the listener, separable so it can run off the accept
/// loop.
#[derive(Clone)]
pub struct PeerAdmitter {
    acceptor: TlsAcceptor,
    gate: TrustGate,
    local_name: String,
}

impl PeerAdmitter {
    /// Run the TLS handshake and the peer handshake line.
    pub async fn establish(&self, pending: PendingPeer) -> Result<Admitted> {
        let PendingPeer { stream, peer_addr } = pending;

        let handshake = timeout(HANDSHAKE_TIMEOUT, self.acceptor.accept(stream)).await;
        let mut stream = match handshake {
            Err(_elapsed) => {
                return Ok(reject(
                    peer_addr,
                    RejectionReason::Handshake("timed out".to_string()),
                ));
            }
            Ok(Err(error)) => {
                return Ok(reject(
                    peer_addr,
                    RejectionReason::Handshake(error.to_string()),
                ));
            }
            Ok(Ok(stream)) => stream,
        };

        let fingerprint = peer_fingerprint(stream.get_ref().1.peer_certificates())?;
        let admission = self.gate.admits(&fingerprint)?;

        let hello = match timeout(HANDSHAKE_TIMEOUT, read_line::<_, PeerHello>(&mut stream)).await {
            Err(_elapsed) => {
                return Ok(reject(
                    peer_addr,
                    RejectionReason::Hello("timed out".to_string()),
                ));
            }
            Ok(Err(error)) => {
                return Ok(reject(peer_addr, RejectionReason::Hello(error.to_string())));
            }
            Ok(Ok(hello)) => hello,
        };

        if hello.version() != PEER_PROTOCOL_VERSION {
            let reason = format!(
                "this device speaks peer protocol {PEER_PROTOCOL_VERSION}, the other speaks {} — \
                 update the older of the two",
                hello.version()
            );
            self.refuse(&mut stream, &reason).await?;
            return Ok(reject(peer_addr, RejectionReason::Hello(reason)));
        }

        // The address to remember this device at. A peer that runs a listener
        // says which port; one that only connects says nothing, and the default
        // port is the guess. Either way the value is advisory — the fingerprint
        // is the identity, and a stale address means "try elsewhere", never
        // "different device".
        let advertised = Some(format!(
            "{}:{}",
            peer_addr.ip(),
            hello.listen_port().unwrap_or(crate::DEFAULT_PEER_PORT)
        ));

        match admission {
            Admission::Trusted(device) => {
                // Keep the recorded address current so the pairing can be used
                // in the other direction without the user looking an IP up.
                if let Some(address) = advertised
                    && Some(&address) != device.address.as_ref()
                {
                    self.gate
                        .record_address(&fingerprint, address)
                        .context("recording the address a trusted peer connected from")?;
                }
                write_line(
                    &mut stream,
                    &PeerWelcome::Ready {
                        version: PEER_PROTOCOL_VERSION,
                        name: self.local_name.clone(),
                    },
                )
                .await?;
                Ok(Admitted::Session(Box::new(PeerSession {
                    stream,
                    fingerprint,
                    peer_name: device.name,
                    peer_addr,
                    paired_now: false,
                })))
            }

            Admission::PairingWindow => {
                let PeerHello::Pair { name, secret, .. } = hello else {
                    let reason = "this device is not paired with yours — pair it with \
                                  `arterm device invite` and `arterm device join` first"
                        .to_string();
                    self.refuse(&mut stream, &reason).await?;
                    return Ok(reject(peer_addr, RejectionReason::PairingExpected));
                };

                if !self.gate.consume_secret(&secret)? {
                    // One message for wrong, expired, and already-spent. The
                    // three are the same instruction to the person holding it,
                    // and the store cannot tell them apart anyway: expired
                    // invites are pruned before the comparison happens.
                    let reason = "that invite is not valid any more — mint a fresh one with \
                         `arterm device invite` on the machine you are connecting to"
                        .to_string();
                    self.refuse(&mut stream, &reason).await?;
                    return Ok(reject(peer_addr, RejectionReason::SecretRefused));
                }

                self.gate
                    .record_pairing(&fingerprint, &name, advertised)
                    .context("recording the device that just paired with this one")?;
                write_line(
                    &mut stream,
                    &PeerWelcome::Paired {
                        version: PEER_PROTOCOL_VERSION,
                        name: self.local_name.clone(),
                    },
                )
                .await?;
                Ok(Admitted::Session(Box::new(PeerSession {
                    stream,
                    fingerprint,
                    peer_name: name,
                    peer_addr,
                    paired_now: true,
                })))
            }

            // Reachable only if the pairing was withdrawn between the TLS
            // handshake and this line. Rare, and still a refusal — the gate is
            // consulted twice precisely so the later answer wins.
            Admission::Refused => {
                let reason = "this device is no longer paired with yours".to_string();
                self.refuse(&mut stream, &reason).await?;
                Ok(reject(peer_addr, RejectionReason::NoLongerTrusted))
            }
        }
    }

    async fn refuse(&self, stream: &mut TlsStream<TcpStream>, reason: &str) -> Result<()> {
        write_line(
            stream,
            &PeerWelcome::Refused {
                reason: reason.to_string(),
            },
        )
        .await
    }
}

fn reject(peer_addr: SocketAddr, reason: RejectionReason) -> Admitted {
    Admitted::Rejected(Rejection { peer_addr, reason })
}

/// A TCP listener bound to one of this machine's own addresses.
pub struct PeerListener {
    listener: TcpListener,
    admitter: PeerAdmitter,
    local_addr: SocketAddr,
    policy: SubnetPolicy,
}

impl PeerListener {
    /// Bind, taking connections from whichever networks this machine is on.
    pub async fn bind(
        bind_addr: SocketAddr,
        credentials: &PeerCredentials,
        gate: TrustGate,
    ) -> Result<Self> {
        Self::bind_with_policy(bind_addr, credentials, gate, SubnetPolicy::ThisMachine).await
    }

    /// Bind against an explicit subnet policy.
    ///
    /// Refuses the wildcard address outright: `0.0.0.0` would put the port on
    /// every network this machine can see, including the ones the same-subnet
    /// rule exists to stay off. Naming an interface address is the difference
    /// between "reachable from my house" and "reachable from wherever this
    /// machine is plugged in".
    pub async fn bind_with_policy(
        bind_addr: SocketAddr,
        credentials: &PeerCredentials,
        gate: TrustGate,
        policy: SubnetPolicy,
    ) -> Result<Self> {
        if subnet::is_wildcard(bind_addr.ip()) {
            anyhow::bail!(
                "refusing to bind the peer listener to {} — name one of this machine's own \
                 addresses so the port is only on the network you meant",
                bind_addr.ip()
            );
        }

        let config = server_config(credentials, gate.clone())?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind(bind_addr)
            .await
            .with_context(|| format!("binding the peer listener to {bind_addr}"))?;
        let local_addr = listener
            .local_addr()
            .context("reading back the peer listener's address")?;

        Ok(Self {
            listener,
            admitter: PeerAdmitter {
                acceptor,
                gate,
                local_name: credentials.name().to_string(),
            },
            local_addr,
            policy,
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// The handshake half, cloneable into a task per connection.
    pub fn admitter(&self) -> PeerAdmitter {
        self.admitter.clone()
    }

    /// Take one connection, applying the same-subnet rule before anything else.
    pub async fn accept(&self) -> Result<Arrival> {
        let (stream, peer_addr) = self
            .listener
            .accept()
            .await
            .context("accepting a peer connection")?;

        let admits = match self.policy.admits(peer_addr.ip()) {
            Ok(admits) => admits,
            Err(error) => {
                // Not being able to answer "is this peer local?" is a refusal,
                // not a pass. The safe reading of "I cannot tell" is no.
                drop(stream);
                return Ok(reject_arrival(
                    peer_addr,
                    RejectionReason::Handshake(format!(
                        "cannot tell which networks this machine is on, so cannot tell whether \
                         the peer is on one of them: {error}"
                    )),
                ));
            }
        };

        if !admits {
            // Closed here, with no TLS exchanged at all. The rule must not
            // depend on anything the far end gets to say.
            drop(stream);
            return Ok(reject_arrival(peer_addr, RejectionReason::OutsideSubnet));
        }

        Ok(Arrival::Pending(PendingPeer { stream, peer_addr }))
    }
}

fn reject_arrival(peer_addr: SocketAddr, reason: RejectionReason) -> Arrival {
    Arrival::Rejected(Rejection { peer_addr, reason })
}
