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
    assert_eq!(bound.to_string(), "[::1]:9000");
    assert_eq!(bound.port(), 9000);
    assert!(bound.is_ipv6());
}

/// Bare loopback V6 is a normal interface name: fill the default peer port.
#[test]
fn a_bare_v6_loopback_gets_the_default_port() {
    let bound = resolve_bind_address(Some("::1")).expect("bare ::1 is an IP");
    assert_eq!(bound.ip().to_string(), "::1");
    assert_eq!(bound.port(), DEFAULT_PEER_PORT);
    assert!(bound.is_ipv6());
}

/// Global bare V6 (no brackets, no port) must parse the same way as bare V4.
#[test]
fn a_bare_global_v6_gets_the_default_port() {
    let bound = resolve_bind_address(Some("2001:db8::1")).expect("bare global V6 is an IP");
    assert_eq!(bound.ip().to_string(), "2001:db8::1");
    assert_eq!(bound.port(), DEFAULT_PEER_PORT);
    assert!(bound.is_ipv6());
}

/// `::1:9000` is ambiguous: Rust's `IpAddr` reads it as hextets ending in `9000`,
/// not as host `::1` with port 9000. Bracketed form is required for a port.
#[test]
fn ambiguous_unbracketed_v6_with_trailing_number_is_an_ip_not_a_hostport() {
    let bound = resolve_bind_address(Some("::1:9000")).expect("IpAddr accepts ::1:9000");
    assert_eq!(
        bound.ip().to_string(),
        "::1:9000",
        "unbracketed form is one IPv6 address, not [::1] plus a port"
    );
    assert_eq!(bound.port(), DEFAULT_PEER_PORT);
    assert_ne!(bound.port(), 9000);
}

/// Parse must accept the V6 wildcard hostport. Bind refusal is PeerListener's job.
#[test]
fn bracketed_v6_wildcard_with_port_parses_successfully() {
    let bound = resolve_bind_address(Some("[::]:9000")).expect("syntax is valid");
    assert_eq!(bound.to_string(), "[::]:9000");
    assert!(bound.ip().is_unspecified());
    assert!(subnet::is_wildcard(bound.ip()));
}

/// Bare `::` is a valid IP that gets the default port; wildcard policy is later.
#[test]
fn bare_v6_wildcard_parses_with_the_default_port() {
    let bound = resolve_bind_address(Some("::")).expect("bare :: is an IP");
    assert!(bound.ip().is_unspecified());
    assert_eq!(bound.port(), DEFAULT_PEER_PORT);
    assert!(subnet::is_wildcard(bound.ip()));
}

#[test]
fn v4_mapped_v6_hostport_is_taken_as_given() {
    let bound =
        resolve_bind_address(Some("[::ffff:192.168.1.5]:9")).expect("v4-mapped V6 hostport");
    assert_eq!(bound.to_string(), "[::ffff:192.168.1.5]:9");
    assert_eq!(bound.port(), 9);
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

/// Hostnames stay rejected: only literal addresses are accepted for bind.
#[test]
fn invalid_hostname_still_errors() {
    for bad in ["localhost", "my-laptop.local", "example.com:7644", ""] {
        let error = resolve_bind_address(Some(bad)).expect_err(bad);
        let text = format!("{error:#}");
        assert!(
            text.contains("neither an address") || text.contains("192.168.1.5:7644"),
            "hostname {bad:?} must stay a parse error, got: {text}"
        );
    }
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

/// A listener started from another arterm session's shell inherits that
/// session's ARTERM_SOCKET. The note must say so, because the peers it
/// accepts will be joined to a daemon whose sessions are not this
/// machine's. This is the exact silent-wrong-target the two-device tour
/// hit: the inherited path is even the *default* socket path of a
/// different runtime dir, so nothing else about it looks wrong.
#[test]
fn an_inherited_socket_from_another_session_earns_a_warning() {
    let note = inherited_socket_note(
        Some(std::ffi::OsStr::new("/run/user/1000/arterm.sock")),
        std::path::Path::new("/tmp/fake-win-home/run/arterm.sock"),
    )
    .expect("an inherited foreign socket must be called out");
    assert!(
        note.contains("inherited"),
        "the note should say the socket came from the environment, got: {note}"
    );
    assert!(
        note.contains("/run/user/1000/arterm.sock"),
        "the note should name the inherited path, got: {note}"
    );
}

/// The common honest case: no ARTERM_SOCKET in the environment, the daemon
/// socket is this machine's own. No note, no noise.
#[test]
fn no_inherited_socket_means_no_note() {
    assert!(
        inherited_socket_note(None, std::path::Path::new("/run/user/1000/arterm.sock")).is_none()
    );
}

/// When the environment names exactly this machine's own default socket the
/// relay target is the expected daemon either way, so the note stays quiet
/// rather than nagging every normal invocation that happens to inherit its
/// own session's socket.
#[test]
fn an_inherited_socket_matching_the_default_path_stays_quiet() {
    assert!(
        inherited_socket_note(
            Some(std::ffi::OsStr::new("/run/user/1000/arterm.sock")),
            std::path::Path::new("/run/user/1000/arterm.sock"),
        )
        .is_none()
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
