//! The handshake line, and the promise that reading it takes exactly one line.

use super::*;
use std::io::Cursor;
use tokio::io::AsyncReadExt;

fn session_hello() -> PeerHello {
    PeerHello::Session {
        version: PEER_PROTOCOL_VERSION,
        name: "desktop".to_string(),
        listen_port: Some(7644),
    }
}

#[tokio::test]
async fn a_hello_survives_the_round_trip() {
    let mut wire = Vec::new();
    write_line(&mut wire, &session_hello())
        .await
        .expect("writing the hello");

    let mut reader = Cursor::new(wire);
    let seen: PeerHello = read_line(&mut reader).await.expect("reading the hello");
    assert_eq!(seen, session_hello());
}

#[tokio::test]
async fn a_pairing_hello_carries_its_secret() {
    let hello = PeerHello::Pair {
        version: PEER_PROTOCOL_VERSION,
        name: "laptop".to_string(),
        secret: "00112233445566778899aabbccddeeff".to_string(),
        listen_port: None,
    };
    let mut wire = Vec::new();
    write_line(&mut wire, &hello).await.expect("writing");

    let mut reader = Cursor::new(wire);
    let seen: PeerHello = read_line(&mut reader).await.expect("reading");
    assert_eq!(seen, hello);
    assert_eq!(seen.name(), "laptop");
    assert_eq!(seen.listen_port(), None);
}

/// The reason the reader goes a byte at a time: the arterm protocol bytes that
/// follow arrive in the same TLS record, and a buffered reader would eat them.
#[tokio::test]
async fn reading_the_hello_leaves_the_protocol_bytes_untouched() {
    let mut wire = Vec::new();
    write_line(&mut wire, &session_hello())
        .await
        .expect("writing the hello");
    wire.extend_from_slice(b"{\"type\":\"subscribe\",\"id\":1}\n");

    let mut reader = Cursor::new(wire);
    let _hello: PeerHello = read_line(&mut reader).await.expect("reading the hello");

    let mut rest = String::new();
    reader
        .read_to_string(&mut rest)
        .await
        .expect("reading what is left");
    assert_eq!(rest, "{\"type\":\"subscribe\",\"id\":1}\n");
}

#[tokio::test]
async fn a_welcome_survives_the_round_trip() {
    let welcome = PeerWelcome::Paired {
        version: PEER_PROTOCOL_VERSION,
        name: "studio".to_string(),
    };
    let mut wire = Vec::new();
    write_line(&mut wire, &welcome).await.expect("writing");

    let mut reader = Cursor::new(wire);
    let seen: PeerWelcome = read_line(&mut reader).await.expect("reading");
    assert_eq!(seen, welcome);
    assert_eq!(seen.peer_name(), Some("studio"));
}

#[tokio::test]
async fn a_refusal_names_no_peer() {
    let refusal = PeerWelcome::Refused {
        reason: "not paired".to_string(),
    };
    assert_eq!(refusal.peer_name(), None);
}

#[tokio::test]
async fn a_line_that_never_ends_is_cut_off() {
    let flood = vec![b'x'; MAX_HELLO_BYTES * 2];
    let mut reader = Cursor::new(flood);
    let error = read_line::<_, PeerHello>(&mut reader)
        .await
        .expect_err("an endless line must not be buffered without limit");
    assert!(
        error.to_string().contains("without ending"),
        "the error should say the line never ended, got: {error}"
    );
}

#[tokio::test]
async fn a_peer_that_hangs_up_mid_line_is_an_error_not_an_empty_hello() {
    let mut reader = Cursor::new(b"{\"kind\":\"sess".to_vec());
    let error = read_line::<_, PeerHello>(&mut reader)
        .await
        .expect_err("a truncated line is not a hello");
    assert!(
        error.to_string().contains("closed the connection"),
        "the error should say the peer hung up, got: {error}"
    );
}

#[tokio::test]
async fn something_that_is_not_a_hello_is_named_as_such() {
    let mut reader = Cursor::new(b"GET / HTTP/1.1\n".to_vec());
    let error = read_line::<_, PeerHello>(&mut reader)
        .await
        .expect_err("an HTTP request is not a hello");
    assert!(
        error.to_string().contains("arterm peer handshake"),
        "the error should name what was expected, got: {error}"
    );
}

/// The version field exists so two machines on different builds fail with a
/// sentence rather than halfway through a session.
#[tokio::test]
async fn a_hello_reports_the_version_it_was_sent_with() {
    let hello = PeerHello::Session {
        version: 99,
        name: "future".to_string(),
        listen_port: None,
    };
    assert_eq!(hello.version(), 99);
    assert_eq!(session_hello().version(), PEER_PROTOCOL_VERSION);
}

/// A peer on a build that predates `details` sends only the id list. Its
/// sessions must still appear — thin, not missing — or adding the field would
/// have broken every pairing with an older machine.
#[test]
fn an_id_only_summary_from_an_older_peer_still_lists_its_sessions() {
    let wire = r#"{"name":"cliff","icon":"C","version":"9.1.0","sessions":["ses_a","ses_b"]}"#;
    let summary: RemoteServerSummary = serde_json::from_str(wire).expect("older peer parses");
    assert!(summary.details.is_empty());

    let shown = summary.display_sessions();
    assert_eq!(shown.len(), 2);
    assert_eq!(shown[0].id, "ses_a");
    assert_eq!(
        shown[0].short_name, "ses_a",
        "with nothing better to show, the id is the name"
    );
    assert_eq!(shown[0].message_count, 0);
}

/// The other direction: a new peer's extra field must not stop an older build
/// from parsing the line. Serde ignores unknown fields, and this pins that.
#[test]
fn an_older_peer_can_parse_a_summary_that_carries_details() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct OldSummary {
        name: String,
        icon: String,
        version: String,
        sessions: Vec<String>,
    }

    let rich = RemoteServerSummary {
        name: "cliff".into(),
        icon: "C".into(),
        version: "9.1.0".into(),
        sessions: vec!["ses_a".into()],
        details: vec![RemoteSessionSummary {
            id: "ses_a".into(),
            short_name: "alpha".into(),
            prompt: "merhaba".into(),
            message_count: 4,
            ..RemoteSessionSummary::default()
        }],
    };
    let wire = serde_json::to_string(&rich).expect("serialize");
    let old: OldSummary = serde_json::from_str(&wire).expect("older build parses");
    assert_eq!(old.sessions, vec!["ses_a".to_string()]);
}

/// When details are present they win, so a peer that can describe its sessions
/// is never shown as bare ids.
#[test]
fn details_are_preferred_over_the_id_list() {
    let summary = RemoteServerSummary {
        sessions: vec!["ses_a".into()],
        details: vec![RemoteSessionSummary {
            id: "ses_a".into(),
            short_name: "alpha".into(),
            message_count: 7,
            ..RemoteSessionSummary::default()
        }],
        ..RemoteServerSummary::default()
    };
    let shown = summary.display_sessions();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].short_name, "alpha");
    assert_eq!(shown[0].message_count, 7);
}

/// Moved here with the predicate it tests: a session that ends is a
/// disconnect, and only the relay cares which kinds count.
#[test]
fn a_peer_hanging_up_is_not_treated_as_a_fault() {
    for kind in [
        std::io::ErrorKind::BrokenPipe,
        std::io::ErrorKind::ConnectionReset,
        std::io::ErrorKind::UnexpectedEof,
        std::io::ErrorKind::NotConnected,
    ] {
        assert!(crate::is_ordinary_disconnect(&std::io::Error::new(
            kind, "gone"
        )));
    }
    assert!(!crate::is_ordinary_disconnect(&std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "refused"
    )));
}
