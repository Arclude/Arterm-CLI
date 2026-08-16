//! What a beacon is allowed to say about the machine that sent it.
//!
//! Announcing and hearing need two machines, so what is pinned here is the
//! decision in between — which datagrams become a device, and where that device
//! is said to be.

use super::*;

fn beacon_bytes(arterm: u8, name: &str, fingerprint: &str, port: u16) -> Vec<u8> {
    serde_json::to_vec(&Beacon {
        arterm,
        name: name.to_string(),
        fingerprint: fingerprint.to_string(),
        port,
    })
    .expect("encoding a beacon")
}

fn other_fingerprint() -> String {
    "ab".repeat(32)
}

fn from(addr: &str) -> SocketAddr {
    addr.parse().expect("valid address")
}

#[test]
fn a_beacon_becomes_a_device_at_the_address_it_came_from() {
    let datagram = beacon_bytes(BEACON_VERSION, "desktop", &other_fingerprint(), 7644);
    let device = device_from_beacon(
        &datagram,
        from("192.168.1.108:41234"),
        "cd".repeat(32).as_str(),
    )
    .expect("a device");

    assert_eq!(device.name, "desktop");
    assert_eq!(device.address_string(), "192.168.1.108:7644");
}

/// The address comes from the packet's source, never from a field inside it —
/// otherwise a beacon could point pairing at a machine that never spoke.
#[test]
fn a_beacon_cannot_name_a_third_party_as_its_address() {
    let datagram = beacon_bytes(BEACON_VERSION, "liar", &other_fingerprint(), 7644);
    let device = device_from_beacon(&datagram, from("10.0.0.9:5555"), "cd".repeat(32).as_str())
        .expect("a device");

    assert_eq!(
        device.address.ip().to_string(),
        "10.0.0.9",
        "the sender's own address is the only one worth believing"
    );
}

/// This machine hears its own broadcasts and must not offer to pair with itself.
#[test]
fn a_machine_does_not_discover_itself() {
    let own = other_fingerprint();
    let datagram = beacon_bytes(BEACON_VERSION, "me", &own, 7644);
    assert!(device_from_beacon(&datagram, from("192.168.1.100:41234"), &own).is_none());
}

/// A future build's beacon is not guessed at.
#[test]
fn a_beacon_from_another_protocol_version_is_ignored() {
    let datagram = beacon_bytes(BEACON_VERSION + 1, "future", &other_fingerprint(), 7644);
    assert!(device_from_beacon(&datagram, from("192.168.1.108:41234"), "cd").is_none());
}

/// Anything else sharing the port is not ours and must not crash the listener.
#[test]
fn an_unrelated_datagram_is_ignored() {
    assert!(device_from_beacon(b"hello", from("192.168.1.108:41234"), "cd").is_none());
    assert!(device_from_beacon(&[], from("192.168.1.108:41234"), "cd").is_none());
}

/// A beacon with a broken fingerprint cannot be verified later, so it is not a
/// device worth showing.
#[test]
fn a_beacon_with_an_unreadable_fingerprint_is_ignored() {
    let datagram = beacon_bytes(BEACON_VERSION, "broken", "not-hex", 7644);
    assert!(device_from_beacon(&datagram, from("192.168.1.108:41234"), "cd").is_none());
}

/// An older build that did not send a port still resolves to the standard one.
#[test]
fn a_beacon_without_a_port_falls_back_to_the_default() {
    let datagram = beacon_bytes(BEACON_VERSION, "old", &other_fingerprint(), 0);
    let device =
        device_from_beacon(&datagram, from("192.168.1.108:41234"), "cd").expect("a device");
    assert_eq!(device.address.port(), DEFAULT_PEER_PORT);
}

/// The limited broadcast is always there, so a machine on a network with no
/// per-interface broadcast address still announces.
#[test]
fn there_is_always_somewhere_to_broadcast_to() {
    let targets = broadcast_targets();
    assert!(!targets.is_empty());
    assert!(
        targets
            .iter()
            .any(|target| target.ip() == IpAddr::V4(Ipv4Addr::BROADCAST))
    );
    assert!(targets.iter().all(|target| target.port() == DISCOVERY_PORT));
}

/// Announcing has to actually reach the network stack. Arrival cannot be shown
/// on one machine — a host does not deliver its own broadcasts to its own
/// sockets, which was verified with a plain UDP probe before this test was
/// written — so what is checked here is that the sends succeed and that the
/// presence says so.
///
/// Ignored by default: it broadcasts on whatever network the machine is on,
/// which is not something a test suite should do unasked. Run it by hand with
/// `cargo test -p arterm-peer real_broadcast -- --ignored --nocapture`.
///
/// Two machines are the only way to prove a beacon is *received*.
#[tokio::test]
#[ignore]
async fn real_broadcast_leaves_this_machine() {
    let fingerprint = Fingerprint::from_hex(&"11".repeat(32)).expect("fingerprint");
    let presence = Presence::open("prober", &fingerprint, DEFAULT_PEER_PORT)
        .await
        .expect("opening a presence");

    for _ in 0..40 {
        if presence.is_announcing() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "no beacon could be sent in 4s: this network refuses broadcast, or there is nowhere to send"
    );
}
