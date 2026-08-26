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

/// A peer switch must say goodbye before dropping the connection: without the
/// Detach request the far server treats the abrupt TCP drop as a crash or a
/// closed session and unregisters it from the picker. This pins the wire side
/// of that handshake — the detached write lands on the socket as a well-formed
/// `detach` request line.
#[tokio::test]
async fn a_peer_switch_sends_a_detach_request_over_the_wire() {
    let mut remote = crate::tui::backend::RemoteConnection::dummy();
    let mut peer = remote
        .take_dummy_peer()
        .expect("dummy connection has a peer end");

    remote.send_detach();

    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 512];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let read =
            tokio::time::timeout(std::time::Duration::from_millis(200), peer.read(&mut chunk))
                .await;
        match read {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => {
                buffer.extend_from_slice(&chunk[..n]);
                if buffer.contains(&b'\n') {
                    break;
                }
            }
            Ok(Err(error)) => panic!("reading the peer end failed: {error}"),
        }
        if std::time::Instant::now() > deadline {
            break;
        }
    }

    let line = String::from_utf8_lossy(&buffer);
    let parsed: serde_json::Value = line
        .trim()
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("the detach write should produce a JSON line");
    assert_eq!(parsed["type"], "detach", "got: {line}");
    assert!(parsed["id"].as_u64().is_some(), "got: {line}");
}

/// The subscribe cwd must follow the session, not the client. A switch to a
/// peer carries the target session's own working dir (as the peer advertised
/// it) so the resumed session — and the boot session the connection starts in —
/// bind to that dir instead of being stamped with this machine's cwd. Coming
/// home clears it, restoring ordinary client-cwd behavior.
#[test]
fn a_peer_switch_carries_the_targets_own_working_dir() {
    let mut app = crate::tui::app::tests::create_test_app();
    let relay = std::env::temp_dir().join("arterm-peer-0123456789abcdef.sock");
    app.workspace_client.queue_peer_switch(crate::tui::workspace_client::PeerSwitch {
        socket: relay,
        session_id: Some("session_windows".to_string()),
        device: "island".to_string(),
        working_dir: Some("C:\\Users\\win\\project".to_string()),
    });

    assert!(crate::tui::app::remote::apply_pending_peer_switch(&mut app));
    assert_eq!(app.resume_session_id.as_deref(), Some("session_windows"));
    assert_eq!(
        app.resume_working_dir.as_deref(),
        Some("C:\\Users\\win\\project"),
        "the peer's session dir must become the subscribe cwd"
    );

    // Coming home: no foreign dir survives the switch back, or every later
    // local resume would report the Windows path as its cwd.
    let home = std::env::temp_dir().join("arterm.sock");
    app.workspace_client.queue_peer_switch(crate::tui::workspace_client::PeerSwitch {
        socket: home,
        session_id: Some("session_local".to_string()),
        device: "this machine".to_string(),
        working_dir: None,
    });
    assert!(crate::tui::app::remote::apply_pending_peer_switch(&mut app));
    assert_eq!(app.resume_working_dir, None);
}
