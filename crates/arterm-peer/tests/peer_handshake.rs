//! Two devices, real certificates, real TLS, real sockets — over loopback.
//!
//! The unit tests pin the arithmetic and the file formats. These pin the thing
//! that actually matters: which connections get through and which do not. Every
//! refusal here is a security property, so each has its own test rather than
//! being implied by the happy path passing.

use std::net::SocketAddr;
use std::path::Path;

use arterm_device::invite::{Invite, PendingInvites};
use arterm_device::{DeviceIdentity, TrustStore};
use arterm_peer::gate::TrustGate;
use arterm_peer::hello::RemoteServerSummary;
use arterm_peer::hello::{
    MAX_HELLO_BYTES, MAX_PREVIEW_CHARS, PEER_PROTOCOL_VERSION, PeerHello, PeerWelcome, read_line,
    write_line,
};
use arterm_peer::listen::{Admitted, Arrival, PeerListener, RejectionReason};
use arterm_peer::subnet::{LocalNetwork, SubnetPolicy};
use arterm_peer::tls::PeerCredentials;
use arterm_peer::{PeerTarget, connect_to_peer, list_peer_sessions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::task::JoinHandle;

/// One machine's worth of state: its own directory, identity, and credentials.
struct Device {
    dir: tempfile::TempDir,
    identity: DeviceIdentity,
}

impl Device {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let identity =
            DeviceIdentity::load_or_create_in(dir.path()).expect("minting a device identity");
        Self { dir, identity }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn gate(&self) -> TrustGate {
        TrustGate::in_dir(self.path())
    }

    fn credentials(&self) -> PeerCredentials {
        PeerCredentials::from_identity(&self.identity).expect("reading this device's identity")
    }

    /// Record `other` the way `arterm device join` would.
    fn trusts(&self, other: &Device, name: &str) {
        self.gate()
            .record_pairing(&other.identity.fingerprint(), name, None)
            .expect("recording a pairing");
    }

    fn forgets(&self, name: &str) {
        let mut trust =
            TrustStore::load_at(self.path().join("trusted.json")).expect("loading the trust store");
        trust.forget(name).expect("forgetting a device");
    }

    fn trust_store(&self) -> TrustStore {
        TrustStore::load_at(self.path().join("trusted.json")).expect("loading the trust store")
    }

    /// Mint an invite the way `arterm device invite` would, returning its secret.
    fn issues_invite(&self) -> String {
        let mut invites = PendingInvites::load_at(self.path().join("invites.json"))
            .expect("loading pending invites");
        let invite =
            Invite::mint("127.0.0.1:7644", self.identity.fingerprint()).expect("minting an invite");
        invites.record(&invite).expect("recording the invite");
        invite.secret
    }

    /// Plant an invite whose window closed an hour ago.
    fn issues_expired_invite(&self, secret: &str) {
        let path = self.path().join("invites.json");
        let mut existing: Vec<serde_json::Value> = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).expect("reading the invite file"),
            Err(_) => Vec::new(),
        };
        let expired = chrono::Utc::now() - chrono::Duration::hours(1);
        existing.push(serde_json::json!({
            "secret": secret,
            "address": "127.0.0.1:7644",
            "expires_at": expired.to_rfc3339(),
        }));
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&existing).expect("encoding the invite file"),
        )
        .expect("writing the invite file");
    }

    fn has_live_invites(&self) -> bool {
        PendingInvites::load_at(self.path().join("invites.json"))
            .expect("loading pending invites")
            .has_live()
    }
}

/// Bind a listener on loopback and hand back one connection's verdict.
async fn listen_once(device: &Device, policy: SubnetPolicy) -> (SocketAddr, JoinHandle<Admitted>) {
    listen_once_with_sessions(device, policy, Vec::new()).await
}

async fn listen_once_with_sessions(
    device: &Device,
    policy: SubnetPolicy,
    sessions: Vec<RemoteServerSummary>,
) -> (SocketAddr, JoinHandle<Admitted>) {
    let bind: SocketAddr = "127.0.0.1:0".parse().expect("a valid bind address");
    let listener =
        PeerListener::bind_with_policy(bind, &device.credentials(), device.gate(), policy)
            .await
            .expect("binding the peer listener")
            .with_local_sessions(std::sync::Arc::new(move || sessions.clone()));
    let addr = listener.local_addr();

    let handle = tokio::spawn(async move {
        match listener.accept().await.expect("accepting") {
            Arrival::Pending(pending) => listener
                .admitter()
                .establish(pending)
                .await
                .expect("establishing"),
            Arrival::Rejected(rejection) => Admitted::Rejected(rejection),
        }
    });
    (addr, handle)
}

fn target_for(device: &Device, addr: SocketAddr) -> PeerTarget {
    PeerTarget {
        address: addr.to_string(),
        fingerprint: device.identity.fingerprint(),
    }
}

fn rejection_reason(admitted: Admitted) -> RejectionReason {
    match admitted {
        Admitted::Rejected(rejection) => rejection.reason,
        Admitted::Session(session) => panic!(
            "expected a refusal, but {} was given a session",
            session.peer_name
        ),
        Admitted::Listed { peer_name, .. } => {
            panic!("expected a refusal, but {peer_name} was given a session list")
        }
    }
}

// ---------------------------------------------------------------------------
// The door that opens
// ---------------------------------------------------------------------------

#[tokio::test]
async fn two_paired_devices_get_a_session_and_the_stream_stays_transparent() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let link = connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        None,
        Some(7644),
    )
    .await
    .expect("a paired device should be able to connect");

    assert!(
        !link.paired_now,
        "an already-paired device is not pairing again"
    );
    assert_eq!(link.peer_name, host.identity.name());

    let admitted = listening.await.expect("the listener task");
    let session = match admitted {
        Admitted::Session(session) => session,
        Admitted::Rejected(rejection) => {
            panic!("a paired device was refused: {}", rejection.reason)
        }
        Admitted::Listed { .. } => panic!("expected a session, got a session list"),
    };
    assert_eq!(session.fingerprint, guest.identity.fingerprint());
    assert!(!session.paired_now);
    assert_eq!(session.peer_addr.ip().to_string(), "127.0.0.1");

    // Everything after the handshake is whatever the two sides send. This is
    // what lets the far end splice the stream straight into the server that
    // already exists, with no protocol change.
    let mut client = link.stream;
    let mut server = session.stream;

    client
        .write_all(b"{\"type\":\"ping\",\"id\":1}\n")
        .await
        .expect("sending a request");
    client.flush().await.expect("flushing");
    let mut server_reader = BufReader::new(&mut server);
    let mut seen = String::new();
    server_reader
        .read_line(&mut seen)
        .await
        .expect("reading the request");
    assert_eq!(seen, "{\"type\":\"ping\",\"id\":1}\n");

    server
        .write_all(b"{\"type\":\"pong\",\"id\":1}\n")
        .await
        .expect("sending an event");
    server.flush().await.expect("flushing");
    let mut client_reader = BufReader::new(&mut client);
    let mut back = String::new();
    client_reader
        .read_line(&mut back)
        .await
        .expect("reading the event");
    assert_eq!(back, "{\"type\":\"pong\",\"id\":1}\n");
}

/// The address a peer connected from is recorded, so the pairing can be used in
/// the other direction without the user looking an IP up.
#[tokio::test]
async fn a_connection_refreshes_the_address_recorded_for_the_peer() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        None,
        Some(9999),
    )
    .await
    .expect("connecting");
    listening.await.expect("the listener task");

    let recorded = host.trust_store();
    let guest_entry = recorded
        .find(&guest.identity.fingerprint())
        .expect("the guest is still trusted");
    assert_eq!(guest_entry.address.as_deref(), Some("127.0.0.1:9999"));
}

/// IPv6 is a first-class peer path: bind, dial with a bracketed hostport,
/// mutual TLS via `ServerName::IpAddress`, and a trust-store refresh that
/// keeps the brackets so the recorded address can be dialled back.
#[tokio::test]
async fn ipv6_loopback_pairs_lists_and_records_a_bracketed_hostport() {
    let host = Device::new();
    let guest = Device::new();
    guest.trusts(&host, "host");
    let secret = {
        let mut invites = PendingInvites::load_at(host.path().join("invites.json"))
            .expect("loading pending invites");
        // Address in the invite is advisory for the join side; the listener
        // binds [::1]:0 below and the guest dials the concrete port.
        let invite =
            Invite::mint("[::1]:7644", host.identity.fingerprint()).expect("minting an invite");
        invites.record(&invite).expect("recording the invite");
        invite.secret
    };

    let bind: SocketAddr = "[::1]:0".parse().expect("a valid IPv6 bind address");
    let advertised_sessions = vec![RemoteServerSummary {
        name: "forge-v6".to_string(),
        icon: "🔥".to_string(),
        version: "v0.10.11-dev".to_string(),
        sessions: vec!["fox".to_string()],
        details: Vec::new(),
    }];
    let listener = PeerListener::bind_with_policy(
        bind,
        &host.credentials(),
        host.gate(),
        SubnetPolicy::ThisMachine,
    )
    .await
    .expect("binding the peer listener on [::1]")
    .with_local_sessions(std::sync::Arc::new({
        let sessions = advertised_sessions.clone();
        move || sessions.clone()
    }));
    let addr = listener.local_addr();
    assert!(addr.is_ipv6(), "listener must be on IPv6, got {addr}");
    assert!(
        addr.to_string().starts_with("[::1]:"),
        "SocketAddr Display should bracket V6, got {addr}"
    );

    // Pairing connection first.
    let listening = {
        let admitter = listener.admitter();
        tokio::spawn(async move {
            match listener.accept().await.expect("accepting") {
                Arrival::Pending(pending) => admitter.establish(pending).await.expect("establish"),
                Arrival::Rejected(rejection) => Admitted::Rejected(rejection),
            }
        })
    };
    let link = connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        Some(&secret),
        Some(9999),
    )
    .await
    .expect("a live invite should pair over IPv6 loopback");
    assert!(link.paired_now);
    assert!(link.peer_addr.is_ipv6());

    let session = match listening.await.expect("the listener task") {
        Admitted::Session(session) => session,
        Admitted::Rejected(rejection) => panic!("IPv6 pair refused: {}", rejection.reason),
        Admitted::Listed { .. } => panic!("expected a session from pairing"),
    };
    assert!(session.paired_now);
    assert_eq!(session.fingerprint, guest.identity.fingerprint());
    assert_eq!(session.peer_addr.ip().to_string(), "::1");

    let recorded = host.trust_store();
    let guest_entry = recorded
        .find(&guest.identity.fingerprint())
        .expect("host records the guest after pairing");
    assert_eq!(
        guest_entry.address.as_deref(),
        Some("[::1]:9999"),
        "admit must refresh a bracketed V6 hostport, not bare ::1:port"
    );

    // List sessions on a fresh IPv6 accept without opening a session.
    let listener = PeerListener::bind_with_policy(
        bind,
        &host.credentials(),
        host.gate(),
        SubnetPolicy::ThisMachine,
    )
    .await
    .expect("rebinding on [::1]")
    .with_local_sessions(std::sync::Arc::new({
        let sessions = advertised_sessions.clone();
        move || sessions.clone()
    }));
    let addr = listener.local_addr();
    let listening = {
        let admitter = listener.admitter();
        tokio::spawn(async move {
            match listener.accept().await.expect("accepting") {
                Arrival::Pending(pending) => admitter.establish(pending).await.expect("establish"),
                Arrival::Rejected(rejection) => Admitted::Rejected(rejection),
            }
        })
    };
    let reported = list_peer_sessions(&guest.credentials(), &target_for(&host, addr))
        .await
        .expect("a paired device should list sessions over IPv6");
    assert_eq!(reported, advertised_sessions);
    match listening.await.expect("the listener task") {
        Admitted::Listed { peer_name, .. } => assert_eq!(peer_name, guest.identity.name()),
        other => panic!("expected Listed over IPv6, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Reciprocal pairing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_live_invite_pairs_the_joiner_on_its_first_connection() {
    let host = Device::new();
    let guest = Device::new();
    // `device join` on the guest records the host from the invite token; the
    // host still knows nothing about the guest.
    guest.trusts(&host, "host");
    let secret = host.issues_invite();
    assert!(
        host.trust_store()
            .find(&guest.identity.fingerprint())
            .is_none(),
        "the host must not know the guest before they connect"
    );

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let link = connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        Some(&secret),
        Some(7644),
    )
    .await
    .expect("a device holding a live invite should be able to pair");

    assert!(
        link.paired_now,
        "the first connection completes the pairing"
    );

    let admitted = listening.await.expect("the listener task");
    let session = match admitted {
        Admitted::Session(session) => session,
        Admitted::Rejected(rejection) => {
            panic!("the invited device was refused: {}", rejection.reason)
        }
        Admitted::Listed { .. } => panic!("expected a session, got a session list"),
    };
    assert!(session.paired_now);
    assert_eq!(session.fingerprint, guest.identity.fingerprint());

    let recorded = host.trust_store();
    let guest_entry = recorded
        .find(&guest.identity.fingerprint())
        .expect("the host now knows the guest");
    assert_eq!(guest_entry.name, guest.identity.name());
    assert_eq!(guest_entry.address.as_deref(), Some("127.0.0.1:7644"));

    assert!(
        !host.has_live_invites(),
        "the secret must be spent by the pairing it completed"
    );
}

/// Pairing continues on the same connection rather than demanding a second
/// dial: a reconnect would prove nothing the secret has not already proved.
#[tokio::test]
async fn the_pairing_connection_is_itself_a_working_session() {
    let host = Device::new();
    let guest = Device::new();
    guest.trusts(&host, "host");
    let secret = host.issues_invite();

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let link = connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        Some(&secret),
        None,
    )
    .await
    .expect("pairing");
    let session = match listening.await.expect("the listener task") {
        Admitted::Session(session) => session,
        Admitted::Rejected(rejection) => panic!("refused: {}", rejection.reason),
        Admitted::Listed { .. } => panic!("expected a session, got a session list"),
    };

    let mut client = link.stream;
    let mut server = session.stream;
    client
        .write_all(b"{\"type\":\"ping\"}\n")
        .await
        .expect("sending");
    client.flush().await.expect("flushing");
    let mut reader = BufReader::new(&mut server);
    let mut seen = String::new();
    reader.read_line(&mut seen).await.expect("reading");
    assert_eq!(seen, "{\"type\":\"ping\"}\n");
}

// ---------------------------------------------------------------------------
// The doors that stay shut
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unpaired_device_never_gets_past_the_handshake() {
    let host = Device::new();
    let stranger = Device::new();
    // The stranger trusts the host, so its own verifier is happy. Only the
    // host's opinion is being tested.
    stranger.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let error = connect_to_peer(
        &stranger.credentials(),
        &target_for(&host, addr),
        None,
        None,
    )
    .await
    .expect_err("an unpaired device must not get a session");
    // In TLS 1.3 the server's verdict on the client certificate arrives after
    // the client's own handshake completes, so this surfaces as an alert on the
    // first read rather than as a handshake error. The message has to name the
    // real cause anyway.
    assert!(
        format!("{error:#}").contains("has not paired with this device"),
        "the failure should say the far end has not paired with us, got: {error:#}"
    );

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert!(
        matches!(reason, RejectionReason::Handshake(_)),
        "an unpaired certificate should die in the handshake, got: {reason}"
    );
}

/// No trust-on-first-use: being reachable, and being the only machine that
/// answered, buys nothing.
#[tokio::test]
async fn an_unpaired_device_is_not_recorded_by_trying() {
    let host = Device::new();
    let stranger = Device::new();
    stranger.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &stranger.credentials(),
        &target_for(&host, addr),
        None,
        None,
    )
    .await
    .expect_err("an unpaired device must not get a session");
    listening.await.expect("the listener task");

    assert!(
        host.trust_store().devices().is_empty(),
        "a refused connection must leave the trust store empty"
    );
}

#[tokio::test]
async fn a_forgotten_device_is_refused_on_its_next_connection() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(&guest.credentials(), &target_for(&host, addr), None, None)
        .await
        .expect("the first connection works");
    listening.await.expect("the listener task");

    host.forgets("guest");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(&guest.credentials(), &target_for(&host, addr), None, None)
        .await
        .expect_err("a forgotten device must be refused");
    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert!(matches!(reason, RejectionReason::Handshake(_)));
}

/// Someone who captured the invite off a chat message arrives after the real
/// joiner has used it.
#[tokio::test]
async fn a_secret_that_has_already_been_spent_is_refused() {
    let host = Device::new();
    let guest = Device::new();
    let eavesdropper = Device::new();
    guest.trusts(&host, "host");
    eavesdropper.trusts(&host, "host");
    let secret = host.issues_invite();

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        Some(&secret),
        None,
    )
    .await
    .expect("the real joiner pairs");
    listening.await.expect("the listener task");

    // The window is closed now that the only invite has been spent, so the
    // replay does not even reach the secret check.
    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &eavesdropper.credentials(),
        &target_for(&host, addr),
        Some(&secret),
        None,
    )
    .await
    .expect_err("a spent secret must not pair a second device");
    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert!(matches!(reason, RejectionReason::Handshake(_)));

    assert!(
        host.trust_store()
            .find(&eavesdropper.identity.fingerprint())
            .is_none(),
        "the replay must not have been recorded"
    );
}

/// The sharper version: another invite is open, so the pairing window is up and
/// the spent secret is judged on its own merits.
#[tokio::test]
async fn a_spent_secret_is_refused_even_while_another_invite_is_open() {
    let host = Device::new();
    let guest = Device::new();
    let eavesdropper = Device::new();
    guest.trusts(&host, "host");
    eavesdropper.trusts(&host, "host");

    let captured = host.issues_invite();
    let _still_open = host.issues_invite();

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &guest.credentials(),
        &target_for(&host, addr),
        Some(&captured),
        None,
    )
    .await
    .expect("the real joiner pairs");
    listening.await.expect("the listener task");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let error = connect_to_peer(
        &eavesdropper.credentials(),
        &target_for(&host, addr),
        Some(&captured),
        None,
    )
    .await
    .expect_err("a spent secret must not pair a second device");
    assert!(
        format!("{error:#}").contains("not valid any more"),
        "the refusal should say the invite is spent, got: {error:#}"
    );

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert_eq!(reason, RejectionReason::SecretRefused);
    assert!(
        host.trust_store()
            .find(&eavesdropper.identity.fingerprint())
            .is_none()
    );
}

#[tokio::test]
async fn an_expired_secret_is_refused_while_another_invite_is_open() {
    let host = Device::new();
    let latecomer = Device::new();
    latecomer.trusts(&host, "host");

    let stale = "00112233445566778899aabbccddeeff";
    host.issues_invite();
    host.issues_expired_invite(stale);

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let error = connect_to_peer(
        &latecomer.credentials(),
        &target_for(&host, addr),
        Some(stale),
        None,
    )
    .await
    .expect_err("an expired secret must not pair anything");
    assert!(format!("{error:#}").contains("not valid any more"));

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert_eq!(reason, RejectionReason::SecretRefused);
    assert!(
        host.trust_store()
            .find(&latecomer.identity.fingerprint())
            .is_none()
    );
}

/// With nothing but an expired invite there is no window at all, so an unknown
/// device dies one door earlier — in the handshake.
#[tokio::test]
async fn an_expired_invite_leaves_no_pairing_window_open() {
    let host = Device::new();
    let latecomer = Device::new();
    latecomer.trusts(&host, "host");

    let stale = "00112233445566778899aabbccddeeff";
    host.issues_expired_invite(stale);

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    connect_to_peer(
        &latecomer.credentials(),
        &target_for(&host, addr),
        Some(stale),
        None,
    )
    .await
    .expect_err("an expired invite opens nothing");
    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert!(matches!(reason, RejectionReason::Handshake(_)));
}

/// The window is for presenting a secret and nothing else. An unpaired device
/// that arrives during one and asks for a session is turned away.
#[tokio::test]
async fn the_pairing_window_does_not_hand_out_sessions() {
    let host = Device::new();
    let stranger = Device::new();
    stranger.trusts(&host, "host");
    host.issues_invite();

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let error = connect_to_peer(
        &stranger.credentials(),
        &target_for(&host, addr),
        None,
        None,
    )
    .await
    .expect_err("an open invite is not an open door");
    assert!(
        format!("{error:#}").contains("not paired"),
        "the refusal should say what to do, got: {error:#}"
    );

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert_eq!(reason, RejectionReason::PairingExpected);
    assert!(
        host.has_live_invites(),
        "a refused session must not spend the invite"
    );
    assert!(host.trust_store().devices().is_empty());
}

// ---------------------------------------------------------------------------
// The same-subnet rule
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_peer_outside_the_subnet_is_dropped_before_any_tls() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    // The listener is on loopback but only accepts 10.0.0.0/8, so a loopback
    // client is exactly the off-subnet case, on a real socket.
    let elsewhere = SubnetPolicy::Fixed(vec![LocalNetwork::new(
        "10.0.0.1".parse().expect("a valid address"),
        8,
    )]);
    let (addr, listening) = listen_once(&host, elsewhere).await;

    connect_to_peer(&guest.credentials(), &target_for(&host, addr), None, None)
        .await
        .expect_err("a peer off the subnet must not get a session");

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert_eq!(
        reason,
        RejectionReason::OutsideSubnet,
        "the refusal must be the subnet rule, not the fingerprint — both devices are paired"
    );
}

#[tokio::test]
async fn dialling_a_device_off_the_local_network_is_refused_before_connecting() {
    let guest = Device::new();
    let target = PeerTarget {
        address: "203.0.113.5:7644".to_string(),
        fingerprint: guest.identity.fingerprint(),
    };
    let error = connect_to_peer(&guest.credentials(), &target, None, None)
        .await
        .expect_err("a destination off the local network must be refused");
    assert!(
        format!("{error:#}").contains("not on any network this machine is on"),
        "the refusal should name the rule, got: {error:#}"
    );
}

#[tokio::test]
async fn the_listener_refuses_to_bind_the_wildcard_address() {
    let host = Device::new();
    let wildcard: SocketAddr = "0.0.0.0:0".parse().expect("a valid address");
    let error = PeerListener::bind(wildcard, &host.credentials(), host.gate())
        .await
        .map(|_listener| ())
        .expect_err("the wildcard puts the port on every network this machine can see");
    assert!(
        format!("{error:#}").contains("refusing to bind"),
        "the refusal should say why, got: {error:#}"
    );
}

// ---------------------------------------------------------------------------
// Wrong machine, wrong version
// ---------------------------------------------------------------------------

/// The inviter's fingerprint travels in the invite so the joiner verifies who
/// answered. Without this check the first connection would be
/// trust-on-first-use, and a machine sitting in the middle of it would be
/// indistinguishable from the real one.
#[tokio::test]
async fn a_device_answering_under_the_wrong_fingerprint_is_refused() {
    let host = Device::new();
    let guest = Device::new();
    let impostor = Device::new();
    host.trusts(&guest, "guest");

    let (addr, _listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;
    let wrong_target = PeerTarget {
        address: addr.to_string(),
        fingerprint: impostor.identity.fingerprint(),
    };
    let error = connect_to_peer(&guest.credentials(), &wrong_target, None, None)
        .await
        .expect_err("the machine that answered is not the one we were told to expect");
    assert!(
        format!("{error:#}").contains("TLS handshake"),
        "the failure should be the handshake, got: {error:#}"
    );
}

/// Two machines on different builds should fail with a sentence, not halfway
/// through a session. Driven by hand because `connect_to_peer` always sends the
/// version it was compiled with.
#[tokio::test]
async fn a_peer_speaking_another_protocol_version_is_told_which_to_update() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let (addr, listening) = listen_once(&host, SubnetPolicy::ThisMachine).await;

    let config = arterm_peer::tls::client_config(&guest.credentials(), host.identity.fingerprint())
        .expect("building a client configuration");
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connecting");
    let server_name = tokio_rustls::rustls::pki_types::ServerName::IpAddress(addr.ip().into());
    let mut stream = connector
        .connect(server_name, tcp)
        .await
        .expect("a paired device completes the handshake whatever it goes on to say");

    write_line(
        &mut stream,
        &PeerHello::Session {
            version: PEER_PROTOCOL_VERSION + 1,
            name: "from the future".to_string(),
            listen_port: None,
        },
    )
    .await
    .expect("sending a hello from a newer build");

    let welcome: PeerWelcome = read_line(&mut stream).await.expect("reading the answer");
    match welcome {
        PeerWelcome::Refused { reason } => assert!(
            reason.contains("update the older of the two"),
            "the refusal should say what to do, got: {reason}"
        ),
        other => panic!("a version mismatch should be refused, got {other:?}"),
    }

    let reason = rejection_reason(listening.await.expect("the listener task"));
    assert!(matches!(reason, RejectionReason::Hello(_)));
}

// ---------------------------------------------------------------------------
// The session list (List query)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_paired_device_can_list_a_peers_sessions_without_opening_one() {
    // This is what backs `arterm device sessions`: ask the far end what it is
    // running, get the answer, and never open a session to do it.
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let advertised = vec![
        RemoteServerSummary {
            name: "forge".to_string(),
            icon: "🔥".to_string(),
            version: "v0.10.3".to_string(),
            sessions: vec!["fox".to_string(), "owl".to_string()],
            details: Vec::new(),
        },
        RemoteServerSummary {
            name: "anvil".to_string(),
            icon: "⚒".to_string(),
            version: "v0.10.3".to_string(),
            sessions: vec![],
            details: Vec::new(),
        },
    ];

    let (addr, listening) =
        listen_once_with_sessions(&host, SubnetPolicy::ThisMachine, advertised.clone()).await;

    let reported = list_peer_sessions(&guest.credentials(), &target_for(&host, addr))
        .await
        .expect("a paired device should be able to list a peer's sessions");

    assert_eq!(reported, advertised, "the list is returned verbatim");

    // The listener side saw a List, not a session.
    match listening.await.expect("the listener task") {
        Admitted::Listed { peer_name, .. } => assert_eq!(peer_name, "guest"),
        other => panic!("a List query should be admitted as Listed, got {other:?}"),
    }
}

/// The live flag is what the other machine's Active list reads. It has to
/// survive the real TLS list, not just a local struct copy: a saved row
/// must stay idle, and an open TUI must stay live, even when the last
/// turn is old.
#[tokio::test]
async fn a_peer_list_keeps_the_live_flag_on_the_wire() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let advertised = vec![RemoteServerSummary {
        name: "camp".to_string(),
        icon: "⛺".to_string(),
        version: "v0.10.16-dev".to_string(),
        sessions: vec!["session_open".to_string(), "session_old".to_string()],
        details: vec![
            arterm_peer::RemoteSessionSummary {
                id: "session_open".to_string(),
                short_name: "sauropod".to_string(),
                title: "Open Windows chat".to_string(),
                last_message_at_ms: 1_000,
                is_active: true,
                ..Default::default()
            },
            arterm_peer::RemoteSessionSummary {
                id: "session_old".to_string(),
                short_name: "owl".to_string(),
                title: "Saved Windows chat".to_string(),
                last_message_at_ms: 1_000,
                is_active: false,
                ..Default::default()
            },
        ],
    }];

    let (addr, listening) =
        listen_once_with_sessions(&host, SubnetPolicy::ThisMachine, advertised).await;
    let reported = list_peer_sessions(&guest.credentials(), &target_for(&host, addr))
        .await
        .expect("a paired device should be able to list a peer's sessions");

    let details = &reported[0].details;
    assert_eq!(details.len(), 2);
    let open = details
        .iter()
        .find(|row| row.id == "session_open")
        .expect("open row");
    let old = details
        .iter()
        .find(|row| row.id == "session_old")
        .expect("saved row");
    assert!(open.is_active, "an open TUI must still look live after TLS");
    assert!(
        !old.is_active,
        "a saved session must not look live after TLS"
    );

    match listening.await.expect("the listener task") {
        Admitted::Listed { peer_name, .. } => assert_eq!(peer_name, "guest"),
        other => panic!("a List query should be admitted as Listed, got {other:?}"),
    }
}

/// The list that used to be impossible.
///
/// The reply was read under the handshake's 4 KiB cap, so a machine with more
/// than a handful of sessions answered with a line the asking device refused —
/// and the CLI turned that refusal into "no sessions", which looks exactly like
/// a laptop that is asleep. A three-session round trip passes either way; only
/// a list too big for one handshake line tells the two apart.
#[tokio::test]
async fn a_session_list_far_larger_than_a_handshake_line_arrives_whole() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let advertised = vec![bulky_server("forge", 100)];
    let encoded = serde_json::to_string(&advertised).expect("encoding the advertised list");
    assert!(
        encoded.len() > 4 * MAX_HELLO_BYTES,
        "the point of this test is a list that cannot be one handshake line, got {} bytes",
        encoded.len()
    );

    let (addr, listening) =
        listen_once_with_sessions(&host, SubnetPolicy::ThisMachine, advertised).await;

    let reported = list_peer_sessions(&guest.credentials(), &target_for(&host, addr))
        .await
        .expect("a long session list must survive the round trip");

    assert_eq!(reported.len(), 1, "one server, however many pages it took");
    assert_eq!(
        reported[0].details.len(),
        100,
        "every session comes back, not just the first page"
    );
    assert_eq!(reported[0].sessions.len(), 100);
    assert_eq!(
        reported[0].details[0].id, "ses_0",
        "the pages go back together in order"
    );
    assert_eq!(reported[0].details[99].id, "ses_99");
    assert!(
        reported[0].details[0].prompt.chars().count() <= MAX_PREVIEW_CHARS + 1,
        "a row's preview is cut on the wire, so page size is predictable"
    );

    match listening.await.expect("the listener task") {
        Admitted::Listed { peer_name, .. } => assert_eq!(peer_name, "guest"),
        other => panic!("a List query should be admitted as Listed, got {other:?}"),
    }
}

/// The other compatibility direction, driven by hand because this build's
/// client always paginates. A device on the released build sends a list request
/// with no page and reads exactly one reply, under the handshake cap. It has to
/// be answered with a line it can actually read — a short list is a worse answer
/// than the whole one and a far better answer than the parse error it gets
/// today.
#[tokio::test]
async fn a_client_that_cannot_paginate_is_still_answered_with_a_readable_list() {
    let host = Device::new();
    let guest = Device::new();
    host.trusts(&guest, "guest");
    guest.trusts(&host, "host");

    let advertised = vec![bulky_server("forge", 100)];
    let (addr, listening) =
        listen_once_with_sessions(&host, SubnetPolicy::ThisMachine, advertised).await;

    let config = arterm_peer::tls::client_config(&guest.credentials(), host.identity.fingerprint())
        .expect("building a client configuration");
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connecting");
    let server_name = tokio_rustls::rustls::pki_types::ServerName::IpAddress(addr.ip().into());
    let mut stream = connector
        .connect(server_name, tcp)
        .await
        .expect("a paired device completes the handshake");

    // The exact line the released build sends: no `page`, because it has none.
    let legacy = serde_json::json!({
        "kind": "list",
        "version": PEER_PROTOCOL_VERSION,
        "name": "guest",
    });
    write_line(&mut stream, &legacy)
        .await
        .expect("sending a list request from a build that predates pagination");

    // And read it the way that build reads it: one line, handshake cap.
    let welcome: PeerWelcome = read_line(&mut stream)
        .await
        .expect("an older client has to be answered with a line it can read");
    match welcome {
        PeerWelcome::Sessions { servers, .. } => {
            let shown: usize = servers.iter().map(|server| server.sessions.len()).sum();
            assert!(shown > 0, "an older client should see sessions, not none");
            assert!(
                shown < 100,
                "a hundred sessions cannot fit a handshake line, so this test proves nothing if \
                 they all arrived"
            );
        }
        other => panic!("a List query should be answered with a list, got {other:?}"),
    }

    match listening.await.expect("the listener task") {
        Admitted::Listed { peer_name, .. } => assert_eq!(peer_name, "guest"),
        other => panic!("a List query should be admitted as Listed, got {other:?}"),
    }
}

/// One server carrying `count` sessions with rows as large as rows get: a first
/// prompt far longer than a row shows, which is what a real machine has.
fn bulky_server(name: &str, count: usize) -> RemoteServerSummary {
    RemoteServerSummary {
        name: name.to_string(),
        icon: "🔥".to_string(),
        version: "9.1.0".to_string(),
        sessions: (0..count).map(|n| format!("ses_{n}")).collect(),
        details: (0..count)
            .map(|n| arterm_peer::RemoteSessionSummary {
                id: format!("ses_{n}"),
                short_name: format!("session {n}"),
                title: format!("what session {n} is about"),
                prompt: "bir istem ".repeat(40),
                message_count: n,
                ..Default::default()
            })
            .collect(),
    }
}

#[tokio::test]
async fn an_unpaired_device_cannot_list_sessions() {
    // Listing is a paired-only capability: an unpaired device is dropped at the
    // fingerprint gate before the List is ever read, exactly like a session.
    let host = Device::new();
    let stranger = Device::new();
    // host does not trust stranger.

    let (addr, listening) =
        listen_once_with_sessions(&host, SubnetPolicy::ThisMachine, Vec::new()).await;

    let result = list_peer_sessions(&stranger.credentials(), &target_for(&host, addr)).await;
    assert!(
        result.is_err(),
        "an unpaired device must not be able to list sessions"
    );
    let _ = listening.await;
}
