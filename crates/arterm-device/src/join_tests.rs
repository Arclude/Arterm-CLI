//! The joiner's copy of an invite: held until the first connection spends it.

use super::*;
use crate::identity::Fingerprint;

fn fingerprint(seed: &[u8]) -> Fingerprint {
    Fingerprint::of_certificate(seed)
}

fn invite_from(seed: &[u8], address: &str) -> Invite {
    Invite::mint(address, fingerprint(seed)).expect("minting an invite")
}

#[test]
fn a_fresh_store_holds_nothing() {
    let dir = tempfile::tempdir().expect("temp dir");
    let joins = PendingJoins::load_at(dir.path().join("joins.json")).expect("loading");
    assert!(joins.active().is_empty());
    assert_eq!(joins.secret_for(&fingerprint(b"anyone")), None);
}

#[test]
fn a_recorded_secret_is_found_by_the_fingerprint_it_belongs_to() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let invite = invite_from(b"inviter", "192.168.1.5:7644");

    let mut joins = PendingJoins::load_at(path.clone()).expect("loading");
    joins.record(&invite).expect("recording");

    let reloaded = PendingJoins::load_at(path).expect("reloading");
    assert_eq!(
        reloaded.secret_for(&invite.fingerprint),
        Some(invite.secret.as_str())
    );
    assert_eq!(
        reloaded.address_for(&invite.fingerprint),
        Some("192.168.1.5:7644")
    );
    assert_eq!(reloaded.secret_for(&fingerprint(b"someone else")), None);
}

/// Re-running `device join` with a fresh invite has to supersede the stale one,
/// not leave two secrets where only the newer will be honoured.
#[test]
fn a_second_invite_from_the_same_device_replaces_the_first() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let first = invite_from(b"inviter", "192.168.1.5:7644");
    let second = invite_from(b"inviter", "192.168.1.6:7644");
    assert_ne!(first.secret, second.secret);

    let mut joins = PendingJoins::load_at(path).expect("loading");
    joins.record(&first).expect("recording the first");
    joins.record(&second).expect("recording the second");

    assert_eq!(joins.active().len(), 1);
    assert_eq!(
        joins.secret_for(&second.fingerprint),
        Some(second.secret.as_str())
    );
}

#[test]
fn invites_from_different_devices_are_held_side_by_side() {
    let dir = tempfile::tempdir().expect("temp dir");
    let laptop = invite_from(b"laptop", "192.168.1.5:7644");
    let studio = invite_from(b"studio", "192.168.1.6:7644");

    let mut joins = PendingJoins::load_at(dir.path().join("joins.json")).expect("loading");
    joins.record(&laptop).expect("recording the laptop");
    joins.record(&studio).expect("recording the studio");

    assert_eq!(joins.active().len(), 2);
    assert_eq!(
        joins.secret_for(&laptop.fingerprint),
        Some(laptop.secret.as_str())
    );
    assert_eq!(
        joins.secret_for(&studio.fingerprint),
        Some(studio.secret.as_str())
    );
}

#[test]
fn clearing_a_secret_removes_it_from_disk() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let invite = invite_from(b"inviter", "192.168.1.5:7644");

    let mut joins = PendingJoins::load_at(path.clone()).expect("loading");
    joins.record(&invite).expect("recording");
    joins.clear(&invite.fingerprint).expect("clearing");

    let reloaded = PendingJoins::load_at(path).expect("reloading");
    assert!(reloaded.active().is_empty());
}

#[test]
fn clearing_a_secret_that_was_never_held_is_not_an_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut joins = PendingJoins::load_at(dir.path().join("joins.json")).expect("loading");
    joins
        .clear(&fingerprint(b"a stranger"))
        .expect("clearing nothing should be quiet");
}

#[test]
fn a_secret_past_its_window_is_dropped_at_load() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let expired = chrono::Utc::now() - chrono::Duration::hours(1);
    let payload = serde_json::json!([{
        "fingerprint": fingerprint(b"inviter").to_hex(),
        "address": "192.168.1.5:7644",
        "secret": "00112233445566778899aabbccddeeff",
        "expires_at": expired.to_rfc3339(),
    }]);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&payload).expect("encoding"),
    )
    .expect("writing");

    let joins = PendingJoins::load_at(path).expect("loading");
    assert!(joins.active().is_empty());
    assert_eq!(joins.secret_for(&fingerprint(b"inviter")), None);
}

/// "I cannot tell when this stops being valid" safely means it already has.
#[test]
fn a_secret_with_an_unreadable_expiry_counts_as_expired() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let payload = serde_json::json!([{
        "fingerprint": fingerprint(b"inviter").to_hex(),
        "address": "192.168.1.5:7644",
        "secret": "00112233445566778899aabbccddeeff",
        "expires_at": "whenever",
    }]);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&payload).expect("encoding"),
    )
    .expect("writing");

    let joins = PendingJoins::load_at(path).expect("loading");
    assert!(joins.active().is_empty());
}

/// A damaged file is a bug or a damaged disk, and saying so is better than
/// continuing as if no invite had ever been accepted.
#[test]
fn a_damaged_file_is_reported_rather_than_treated_as_empty() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    std::fs::write(&path, "{ this is not json").expect("writing");

    let error = PendingJoins::load_at(path).expect_err("a damaged file should be reported");
    assert!(
        error.to_string().contains("malformed"),
        "the error should say the file is malformed, got: {error}"
    );
}

#[cfg(unix)]
#[test]
fn the_file_is_readable_only_by_its_owner() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");
    let mut joins = PendingJoins::load_at(path.clone()).expect("loading");
    joins
        .record(&invite_from(b"inviter", "192.168.1.5:7644"))
        .expect("recording");

    let mode = std::fs::metadata(&path)
        .expect("reading permissions")
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o777,
        0o600,
        "a file holding live pairing secrets must not be group or world readable"
    );
}

/// Zone-bearing link-local addresses must survive the real joins.json write
/// path, not only an in-memory clone of `PendingJoin`. Both spellings that
/// dial accepts (bare `%ifname` and bracketed numeric `%N`) are opaque string
/// payload here: save/load must not normalise, strip, or re-encode the zone.
#[test]
fn zone_bearing_addresses_survive_joins_json_disk_round_trip() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("joins.json");

    // Bare interface name (common on invite tokens typed/pasted by a person)
    // and bracketed numeric scope (what SocketAddr::to_string often emits).
    let bare_ifname = "fe80::1%eth0:7644";
    let bracket_numeric = "[fe80::2%3]:7644";

    let bare_invite = invite_from(b"bare-zone-peer", bare_ifname);
    let bracket_invite = invite_from(b"bracket-zone-peer", bracket_numeric);

    {
        let mut joins = PendingJoins::load_at(path.clone()).expect("loading empty store");
        joins.record(&bare_invite).expect("recording bare %ifname");
        joins
            .record(&bracket_invite)
            .expect("recording bracket numeric");
    }

    // Live disk bytes, not the still-open in-memory store: prove serde wrote
    // the zone markers through, rather than only keeping them in RAM.
    let on_disk = std::fs::read_to_string(&path).expect("reading joins.json bytes");
    assert!(
        on_disk.contains(bare_ifname),
        "joins.json must keep bare %ifname zone text verbatim, got:\n{on_disk}"
    );
    assert!(
        on_disk.contains(bracket_numeric),
        "joins.json must keep bracket numeric zone text verbatim, got:\n{on_disk}"
    );
    assert!(
        on_disk.contains('%'),
        "zone separator must not be stripped from joins.json, got:\n{on_disk}"
    );

    // Drop every handle, then load_at from the path alone.
    let reloaded = PendingJoins::load_at(path).expect("reloading from disk");
    assert_eq!(
        reloaded.address_for(&bare_invite.fingerprint),
        Some(bare_ifname),
        "bare %ifname must round-trip through PendingJoins save/load"
    );
    assert_eq!(
        reloaded.address_for(&bracket_invite.fingerprint),
        Some(bracket_numeric),
        "bracket numeric zone must round-trip through PendingJoins save/load"
    );
    assert_eq!(reloaded.active().len(), 2);
}
