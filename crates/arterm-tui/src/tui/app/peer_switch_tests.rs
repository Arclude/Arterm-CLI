//! Which machine a chosen session resumes on.
//!
//! Standing up a relay needs two machines and a network. What is pinned here is
//! the decision in front of it — the one that decided, wrongly at first, that a
//! local session could be resumed on whatever server the client happened to be
//! pointed at.

use super::*;
use std::path::Path;

/// Nothing to come back from: the client has never left this machine, so a
/// local row resumes where it already is.
#[test]
fn a_client_that_never_switched_stays_put() {
    assert_eq!(way_home(None, Path::new("/run/arterm.sock")), None);
}

/// The case that made the move one-way. Pointed at a peer relay, a local row
/// has to bring the client home first.
#[test]
fn a_local_row_comes_home_from_a_peer() {
    let home = Path::new("/run/arterm.sock");
    let peer = Path::new("/run/arterm-peer-0123456789abcdef.sock");
    assert_eq!(way_home(Some(home), peer), Some(home));
}

/// Already back: switching again would reconnect for nothing.
#[test]
fn a_client_already_home_does_not_switch_again() {
    let home = Path::new("/run/arterm.sock");
    assert_eq!(way_home(Some(home), home), None);
}

/// A client started with its own `ARTERM_SOCKET` returns to *that*, not to the
/// default daemon path — which is why the socket is captured on the way out
/// rather than assumed.
#[test]
fn home_is_wherever_the_client_started() {
    let home = Path::new("/tmp/test-run/custom.sock");
    let peer = Path::new("/tmp/test-run/arterm-peer-0123456789abcdef.sock");
    assert_eq!(way_home(Some(home), peer), Some(home));
}

/// The relay socket is named after the device so two peers cannot collide, and
/// carries the prefix the rest of the client keys "am I on a peer?" on.
#[test]
fn a_relay_socket_is_named_for_its_device() {
    let a = Fingerprint::from_hex(&"ab".repeat(32)).expect("fingerprint");
    let b = Fingerprint::from_hex(&"cd".repeat(32)).expect("fingerprint");

    let path_a = relay_socket_path(&a).expect("socket path");
    let path_b = relay_socket_path(&b).expect("socket path");

    assert_ne!(path_a, path_b, "two devices must not share one socket");
    for path in [&path_a, &path_b] {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("socket file name");
        assert!(name.starts_with("arterm-peer-"), "{name}");
        assert!(name.ends_with(".sock"), "{name}");
    }
}
