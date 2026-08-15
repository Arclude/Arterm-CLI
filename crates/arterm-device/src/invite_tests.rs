use super::*;

fn fingerprint() -> Fingerprint {
    Fingerprint::from_hex(&"3c".repeat(32)).expect("fingerprint")
}

#[test]
fn a_token_round_trips() {
    let invite = Invite::mint("192.168.1.42:7420", fingerprint()).expect("mint");
    let parsed = Invite::parse(&invite.to_token()).expect("parse");
    assert_eq!(parsed, invite);
}

#[test]
fn a_token_carries_the_address_the_fingerprint_and_the_secret() {
    // All three are load-bearing: without the fingerprint the first connection
    // is trust-on-first-use and a machine in the middle is indistinguishable
    // from the real one.
    let invite = Invite::mint("10.0.0.5:7420", fingerprint()).expect("mint");
    let token = invite.to_token();

    assert!(token.contains("10.0.0.5:7420"), "{token}");
    assert!(token.contains(&fingerprint().to_hex()), "{token}");
    assert!(token.contains(&invite.secret), "{token}");
}

#[test]
fn two_invites_never_share_a_secret() {
    let a = Invite::mint("host:1", fingerprint()).expect("mint");
    let b = Invite::mint("host:1", fingerprint()).expect("mint");
    assert_ne!(a.secret, b.secret);
    assert_eq!(a.secret.len(), 32, "16 random bytes, hex encoded");
}

#[test]
fn minting_without_an_address_is_refused() {
    assert!(Invite::mint("   ", fingerprint()).is_err());
}

#[test]
fn truncated_tokens_say_what_is_missing() {
    // This is the one string a user copies by hand, so a bad paste has to
    // point at the paste rather than at "invalid invite".
    let invite = Invite::mint("192.168.1.42:7420", fingerprint()).expect("mint");
    let token = invite.to_token();

    let no_scheme = Invite::parse("192.168.1.42:7420#abc.def").expect_err("no scheme");
    assert!(no_scheme.to_string().contains("arterm://"), "{no_scheme}");

    let no_hash = Invite::parse("arterm://192.168.1.42:7420").expect_err("no fragment");
    assert!(no_hash.to_string().contains("cut short"), "{no_hash}");

    let cut = &token[..token.len() - 33];
    let no_secret = Invite::parse(cut).expect_err("no secret");
    assert!(no_secret.to_string().contains("cut short"), "{no_secret}");
}

#[test]
fn a_token_with_a_broken_fingerprint_is_rejected() {
    let error = Invite::parse("arterm://host:7420#notavalidfingerprint.abcdef")
        .expect_err("bad fingerprint");
    assert!(error.to_string().contains("fingerprint"), "{error}");
}

#[test]
fn whitespace_around_a_pasted_token_is_tolerated() {
    let invite = Invite::mint("192.168.1.42:7420", fingerprint()).expect("mint");
    let padded = format!("  {}\n", invite.to_token());
    assert_eq!(Invite::parse(&padded).expect("parse"), invite);
}

#[test]
fn issued_invites_are_recorded_and_reload() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("invites.json");
    let invite = Invite::mint("192.168.1.42:7420", fingerprint()).expect("mint");

    let mut pending = PendingInvites::load_at(path.clone()).expect("load");
    pending.record(&invite).expect("record");

    let reloaded = PendingInvites::load_at(path).expect("reload");
    assert_eq!(reloaded.active().len(), 1);
    assert_eq!(reloaded.active()[0].secret, invite.secret);
}

#[test]
fn expired_invites_are_dropped_on_load() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("invites.json");
    let stale = chrono::Utc::now() - chrono::Duration::seconds(1);
    let encoded = serde_json::to_string(&vec![PendingInvite {
        secret: "deadbeef".to_string(),
        address: "192.168.1.42:7420".to_string(),
        expires_at: stale.to_rfc3339(),
    }])
    .expect("encode");
    std::fs::write(&path, encoded).expect("write");

    let pending = PendingInvites::load_at(path).expect("load");
    assert!(
        pending.active().is_empty(),
        "an invite past its window must not still open a door"
    );
}

#[test]
fn an_invite_with_an_unreadable_expiry_counts_as_expired() {
    // "I cannot tell when this stops being valid" reads as already expired,
    // not as valid forever.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("invites.json");
    let encoded = serde_json::to_string(&vec![PendingInvite {
        secret: "deadbeef".to_string(),
        address: "192.168.1.42:7420".to_string(),
        expires_at: "whenever".to_string(),
    }])
    .expect("encode");
    std::fs::write(&path, encoded).expect("write");

    assert!(
        PendingInvites::load_at(path)
            .expect("load")
            .active()
            .is_empty()
    );
}

#[test]
fn a_damaged_invite_file_is_an_error_not_an_empty_list() {
    // Only this crate writes the file, so unreadable content means a bug or a
    // damaged disk. Continuing as though no invite was ever issued would hide
    // that; the message points at the fix instead.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("invites.json");
    std::fs::write(&path, "{ not json").expect("write");

    let error = PendingInvites::load_at(path).expect_err("malformed file must fail");
    assert!(error.to_string().contains("malformed"), "{error}");
}
