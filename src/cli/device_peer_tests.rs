//! The decisions `device connect` and `device listen` make before any socket
//! exists. The transport itself is exercised in `arterm-peer`.

use super::*;

fn fingerprint(seed: &[u8]) -> Fingerprint {
    Fingerprint::of_certificate(seed)
}

fn trusted(address: Option<&str>) -> TrustedDevice {
    TrustedDevice {
        fingerprint: fingerprint(b"the laptop").to_hex(),
        name: "laptop".to_string(),
        address: address.map(str::to_string),
        paired_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn no_joins() -> PendingJoins {
    let dir = std::env::temp_dir().join(format!("arterm-device-peer-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("joins.json");
    crate::transport::remove_socket(&path);
    PendingJoins::load_at(path).expect("an empty join store")
}

#[test]
fn an_address_and_port_is_taken_as_given() {
    let bound = resolve_bind_address(Some("192.168.1.5:9000")).expect("a valid address");
    assert_eq!(bound.to_string(), "192.168.1.5:9000");
}

/// Naming only the interface is the common case, so the port fills itself in.
#[test]
fn an_address_without_a_port_gets_the_default_one() {
    let bound = resolve_bind_address(Some("192.168.1.5")).expect("a valid address");
    assert_eq!(bound.ip().to_string(), "192.168.1.5");
    assert_eq!(bound.port(), DEFAULT_PEER_PORT);
}

#[test]
fn a_v6_address_and_port_is_taken_as_given() {
    let bound = resolve_bind_address(Some("[::1]:9000")).expect("a valid address");
    assert_eq!(bound.port(), 9000);
    assert!(bound.is_ipv6());
}

#[test]
fn something_that_is_not_an_address_says_what_one_looks_like() {
    let error = resolve_bind_address(Some("my-laptop")).expect_err("not an address");
    assert!(
        format!("{error:#}").contains("192.168.1.5:7644"),
        "the error should show the shape expected, got: {error:#}"
    );
}

#[test]
fn an_explicit_address_beats_the_recorded_one() {
    let entry = trusted(Some("192.168.1.5:7644"));
    let address = peer_address(
        "laptop",
        &entry,
        &fingerprint(b"the laptop"),
        &no_joins(),
        Some("10.0.0.9:7644".to_string()),
    )
    .expect("an explicit address is always usable");
    assert_eq!(address, "10.0.0.9:7644");
}

#[test]
fn the_recorded_address_is_used_when_none_is_given() {
    let entry = trusted(Some("192.168.1.5:7644"));
    let address = peer_address(
        "laptop",
        &entry,
        &fingerprint(b"the laptop"),
        &no_joins(),
        None,
    )
    .expect("the trust store knows where it is");
    assert_eq!(address, "192.168.1.5:7644");
}

/// A device paired from the other direction has no address recorded until it
/// connects, so telling the user "no address" would be wrong while the invite
/// that named one is still held.
#[test]
fn a_device_with_no_recorded_address_says_what_to_do() {
    let entry = trusted(None);
    let error = peer_address(
        "laptop",
        &entry,
        &fingerprint(b"the laptop"),
        &no_joins(),
        None,
    )
    .expect_err("nothing knows where this device is");
    assert!(
        format!("{error:#}").contains("--address"),
        "the error should name the flag that fixes it, got: {error:#}"
    );
}

#[test]
fn the_local_socket_is_named_after_the_device_and_not_after_the_daemon() {
    let path = default_proxy_socket(&fingerprint(b"the laptop")).expect("a socket path");
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("a file name");
    assert!(
        name.starts_with("arterm-peer-"),
        "the name should mark it as a peer socket, got: {name}"
    );
    assert_ne!(
        name, "arterm.sock",
        "the peer socket must never collide with the local daemon's"
    );

    let other = default_proxy_socket(&fingerprint(b"the studio")).expect("a socket path");
    assert_ne!(
        path, other,
        "two peer sessions on one machine need two sockets"
    );
}

/// The local socket is a door to another machine's agent, so it must not be
/// walkable by anyone else sharing this host.
#[cfg(unix)]
#[tokio::test]
async fn the_local_socket_is_reachable_only_by_its_owner() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("arterm-peer-perm-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("probe.sock");
    crate::transport::remove_socket(&path);
    let _listener = crate::transport::Listener::bind(&path).expect("binding a local socket");
    restrict_to_owner(&path).expect("restricting the socket");

    let mode = std::fs::metadata(&path)
        .expect("reading permissions")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "mode was {:o}", mode & 0o777);

    crate::transport::remove_socket(&path);
    std::fs::remove_dir_all(&dir).expect("cleaning up");
}

#[test]
fn a_peer_hanging_up_is_not_treated_as_a_fault() {
    for kind in [
        std::io::ErrorKind::BrokenPipe,
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::UnexpectedEof,
        std::io::ErrorKind::NotConnected,
    ] {
        assert!(is_ordinary_disconnect(&std::io::Error::new(kind, "gone")));
    }
    assert!(!is_ordinary_disconnect(&std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "refused"
    )));
}
