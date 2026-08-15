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
