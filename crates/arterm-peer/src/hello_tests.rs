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

/// The bug this file used to miss entirely. A three-session list fits in a
/// handshake line, so every test here passed while the real thing — a machine
/// with a hundred sessions — could not be listed at all. This is that list.
#[tokio::test]
async fn a_session_list_longer_than_a_handshake_line_still_reads() {
    let welcome = bulky_sessions(40);
    let mut wire = Vec::new();
    write_line(&mut wire, &welcome)
        .await
        .expect("writing the session list");
    assert!(
        wire.len() > MAX_HELLO_BYTES,
        "this test is only worth running if the list is bigger than a handshake line, got {} bytes",
        wire.len()
    );

    let mut reader = Cursor::new(wire.clone());
    let seen: PeerWelcome = read_line_with_limit(&mut reader, MAX_SESSION_LIST_BYTES)
        .await
        .expect("a session list is read under the data cap, not the handshake cap");
    assert_eq!(seen, welcome);

    // And the handshake cap is still the handshake cap: the same line read as
    // a handshake is refused, which is what it was doing to every long list.
    let mut reader = Cursor::new(wire);
    let error = read_line::<_, PeerWelcome>(&mut reader)
        .await
        .expect_err("a handshake read must still stop at its own limit");
    assert!(
        error.to_string().contains("without ending"),
        "the error should name the limit that stopped it, got: {error}"
    );
}

/// The protection the larger cap must not have removed: a *handshake* line over
/// the limit is still refused, even when it is well-formed JSON.
#[tokio::test]
async fn a_well_formed_handshake_line_over_the_cap_is_still_refused() {
    let hello = PeerHello::Session {
        version: PEER_PROTOCOL_VERSION,
        name: "n".repeat(MAX_HELLO_BYTES),
        listen_port: None,
    };
    let mut wire = Vec::new();
    write_line(&mut wire, &hello).await.expect("writing");
    assert!(wire.len() > MAX_HELLO_BYTES);

    let mut reader = Cursor::new(wire);
    let error = read_line::<_, PeerHello>(&mut reader)
        .await
        .expect_err("an oversized handshake is not admitted just because it parses");
    assert!(
        error
            .to_string()
            .contains(&format!("more than {MAX_HELLO_BYTES} bytes")),
        "the error should name the handshake limit, got: {error}"
    );
}

/// A peer on a build that predates pagination sends neither field. Its reply
/// must still parse, and must not claim there is another page — there is no
/// second page coming and the connection is about to close.
#[test]
fn an_older_peers_reply_carries_no_pagination_and_still_parses() {
    let wire = format!(
        r#"{{"kind":"sessions","version":{PEER_PROTOCOL_VERSION},"name":"cliff","servers":[{{"name":"forge","icon":"F","version":"9.1.0","sessions":["ses_a","ses_b"]}}]}}"#
    );
    let welcome: PeerWelcome = serde_json::from_str(&wire).expect("an older peer's reply parses");
    match welcome {
        PeerWelcome::Sessions {
            servers,
            more,
            total,
            ..
        } => {
            assert!(!more, "a peer that cannot paginate is never asked again");
            assert_eq!(total, None, "an older peer does not know the total");
            assert_eq!(servers.len(), 1);
            assert_eq!(servers[0].session_count(), 2);
            assert_eq!(servers[0].display_sessions().len(), 2);
        }
        other => panic!("expected a session list, got {other:?}"),
    }
}

/// The request in the same direction: an older peer asks without a page, and
/// that absence is what tells this side to answer in one short line.
#[test]
fn an_older_peers_list_request_carries_no_page() {
    let wire = format!(r#"{{"kind":"list","version":{PEER_PROTOCOL_VERSION},"name":"cliff"}}"#);
    let hello: PeerHello = serde_json::from_str(&wire).expect("an older peer's request parses");
    match hello {
        PeerHello::List { page, .. } => assert_eq!(page, None),
        other => panic!("expected a list request, got {other:?}"),
    }
}

/// And the other direction: the added fields must not stop an older build from
/// reading a reply. Serde ignores what it does not know, and this pins it.
#[test]
fn an_older_build_can_parse_a_paginated_reply() {
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct OldWelcome {
        kind: String,
        version: u32,
        name: String,
        servers: Vec<RemoteServerSummary>,
    }

    let wire = serde_json::to_string(&bulky_sessions(2)).expect("serialize");
    let old: OldWelcome = serde_json::from_str(&wire).expect("an older build parses");
    assert_eq!(old.kind, "sessions");
    assert_eq!(old.servers[0].session_count(), 2);
}

/// Paging is over sessions, not servers, so a page boundary can fall inside a
/// server. Every session has to arrive exactly once and in order anyway.
#[test]
fn pages_cover_every_session_once_and_in_order() {
    let servers = servers_to_page();
    let mut collected: Vec<RemoteServerSummary> = Vec::new();
    let mut offset = 0usize;
    let mut pages = 0usize;
    loop {
        let (page, more) = page_of_servers(&servers, offset, 3);
        offset += total_sessions(&page);
        merge_session_pages(&mut collected, page);
        pages += 1;
        assert!(pages < 10, "paging should terminate, not spin");
        if !more {
            break;
        }
    }
    assert!(pages > 1, "eight sessions in threes is more than one page");
    assert_eq!(
        collected, servers,
        "the pages put back together are the original list"
    );
}

/// A server with nothing running is real information — that machine is
/// listening and idle — so it is sent, but only once, or merging would stack
/// copies of it under one name.
#[test]
fn an_idle_server_rides_on_the_first_page_only() {
    let servers = servers_to_page();
    let (first, _more) = page_of_servers(&servers, 0, 3);
    let (second, _more) = page_of_servers(&servers, 3, 3);
    assert!(first.iter().any(|server| server.name == "anvil"));
    assert!(!second.iter().any(|server| server.name == "anvil"));
}

/// A row shows a one-line preview, so the wire carries a preview's worth. This
/// is what keeps a page's size a property of the page size rather than of the
/// longest prompt anyone ever typed.
#[test]
fn a_long_preview_is_cut_to_a_row_and_marked() {
    let summary = RemoteSessionSummary {
        // Multi-byte on purpose: cutting UTF-8 by byte index panics here.
        prompt: "ü".repeat(MAX_PREVIEW_CHARS * 3),
        title: "kısa".to_string(),
        ..RemoteSessionSummary::default()
    }
    .trimmed_for_wire();

    assert_eq!(summary.prompt.chars().count(), MAX_PREVIEW_CHARS + 1);
    assert!(
        summary.prompt.ends_with('…'),
        "a cut preview should say it was cut"
    );
    assert_eq!(summary.title, "kısa", "a short title is left alone");
}

/// A peer that cannot paginate reads one line under the handshake cap. It gets
/// as much as fits, with the honest total alongside — a short list beats the
/// parse error that build gets from a full one.
#[test]
fn a_peer_that_cannot_paginate_is_answered_with_what_it_can_read() {
    let servers = vec![bulky_server(100)];
    let welcome = sessions_within_budget(PEER_PROTOCOL_VERSION, "host", &servers, MAX_HELLO_BYTES);
    let encoded = serde_json::to_vec(&welcome).expect("serialize");
    assert!(
        // Strictly under: the last byte of the budget is the newline.
        encoded.len() < MAX_HELLO_BYTES,
        "the answer has to fit what that peer will read, got {} bytes",
        encoded.len()
    );

    match welcome {
        PeerWelcome::Sessions {
            servers: sent,
            more,
            total,
            ..
        } => {
            assert!(!more, "nothing further is exchanged with that peer");
            assert_eq!(
                total,
                Some(100),
                "the total is told even when the list is not"
            );
            let shown = total_sessions(&sent);
            assert!(shown > 0, "something has to fit, got nothing");
            assert!(
                shown < 100,
                "not all of it fits, or this test proves nothing"
            );
        }
        other => panic!("expected a session list, got {other:?}"),
    }
}

/// One server carrying `count` sessions with rows as large as rows get.
fn bulky_server(count: usize) -> RemoteServerSummary {
    RemoteServerSummary {
        name: "forge".to_string(),
        icon: "🔥".to_string(),
        version: "9.1.0".to_string(),
        sessions: (0..count).map(|n| format!("ses_{n}")).collect(),
        details: (0..count)
            .map(|n| RemoteSessionSummary {
                id: format!("ses_{n}"),
                short_name: format!("session {n}"),
                title: "a title with room in it".to_string(),
                prompt: "bir istem ".repeat(20),
                message_count: n,
                ..RemoteSessionSummary::default()
            })
            .collect(),
    }
}

fn bulky_sessions(count: usize) -> PeerWelcome {
    PeerWelcome::Sessions {
        version: PEER_PROTOCOL_VERSION,
        name: "host".to_string(),
        servers: vec![bulky_server(count)],
        more: false,
        total: Some(count),
    }
}

/// Three servers, eight sessions between them, one of them idle.
fn servers_to_page() -> Vec<RemoteServerSummary> {
    let named = |name: &str, ids: &[&str]| RemoteServerSummary {
        name: name.to_string(),
        icon: "S".to_string(),
        version: "9.1.0".to_string(),
        sessions: ids.iter().map(|id| id.to_string()).collect(),
        details: ids
            .iter()
            .map(|id| RemoteSessionSummary {
                id: (*id).to_string(),
                short_name: (*id).to_string(),
                ..RemoteSessionSummary::default()
            })
            .collect(),
    };
    vec![
        named("forge", &["a", "b", "c", "d", "e"]),
        named("anvil", &[]),
        named("sessions", &["f", "g", "h"]),
    ]
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
