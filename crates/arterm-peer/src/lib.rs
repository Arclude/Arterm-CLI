//! The wire between two paired machines.
//!
//! [`arterm_device`] decides *who* a machine is and *which* machines it will
//! accept. This crate is what those answers are for: a mutually authenticated
//! TLS listener, a connector that dials one, and the handshake that completes a
//! pairing the first time the two meet.
//!
//! # What authenticates a peer
//!
//! Both ends present their device certificate and each checks the other's
//! SHA-256 fingerprint against its own trust store. There is no certificate
//! authority and no chain to walk — the certificates are self-signed, so the
//! fingerprint comparison *is* the authentication. That is why [`tls`] replaces
//! rustls' verifiers rather than configuring them: a chain check would pass for
//! any self-signed certificate on the network, which is the same as no check.
//!
//! Signature verification is *not* replaced. The custom verifiers still call
//! rustls' own `verify_tls12_signature` / `verify_tls13_signature`, because a
//! matching fingerprint only proves the peer sent a certificate we recognise;
//! the handshake signature is what proves it holds the matching private key.
//! Anyone can copy a certificate off the wire. Nobody can copy the key.
//!
//! # Three doors, all locked
//!
//! A connection has to get past all of these, in this order:
//!
//! 1. **The subnet.** [`subnet`] refuses a source address outside this
//!    machine's own networks before a single TLS byte is read. The user's rule
//!    is that only machines on the same network participate, and nothing else
//!    here implies it: a paired laptop reachable from the open internet would
//!    otherwise be admitted on its fingerprint alone.
//! 2. **The fingerprint.** [`gate`] answers from the trust store on disk,
//!    reloaded per handshake so `arterm device forget` takes effect on the next
//!    connection rather than the next restart. An unknown fingerprint fails the
//!    TLS handshake. There is no trust-on-first-use fallback.
//! 3. **The one-time secret.** An unknown device gets past the second door only
//!    while an invite this machine issued is still live, and only far enough to
//!    present that invite's secret. A wrong, expired, or already-spent secret
//!    ends the connection with no session and no trust recorded.
//!
//! # What rides on top
//!
//! Nothing about the arterm protocol changes. Once [`hello`] has exchanged one
//! line in each direction the stream carries the same newline-delimited JSON a
//! local Unix-socket client speaks, so the far end can splice it straight into
//! the server that already exists.

pub mod connect;
pub mod gate;
pub mod hello;
pub mod listen;
pub mod subnet;
pub mod tls;

pub use connect::{
    PeerLink, PeerTarget, connect_to_peer, is_ordinary_disconnect, list_peer_sessions,
    relay_local_stream,
};
pub use gate::{Admission, TrustGate};
pub use hello::{PeerHello, PeerWelcome, RemoteServerSummary, RemoteSessionSummary};
pub use listen::{
    Admitted, Arrival, LocalSessions, PeerAdmitter, PeerListener, PeerSession, PendingPeer,
    Rejection, RejectionReason,
};
pub use subnet::{LocalNetwork, SubnetPolicy};
pub use tls::PeerCredentials;

/// Port a peer listener uses when none is given.
///
/// One above the gateway's 7643 so the two never collide on a machine running
/// both, and outside the range a browser will dial on its own.
pub const DEFAULT_PEER_PORT: u16 = 7644;
