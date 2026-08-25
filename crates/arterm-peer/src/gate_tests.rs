//! The verdict the TLS handshake acts on. Every case here is a door: the ones
//! that open and, more importantly, the ones that stay shut.

use super::*;
use arterm_device::invite::{Invite, PendingInvites};

fn fingerprint(seed: &[u8]) -> Fingerprint {
    Fingerprint::of_certificate(seed)
}

fn trust_a_device(dir: &Path, fingerprint: &Fingerprint, name: &str) {
    let mut trust =
        TrustStore::load_at(dir.join("trusted.json")).expect("a fresh trust store loads");
    trust
        .trust(TrustedDevice {
            fingerprint: fingerprint.to_hex(),
            name: name.to_string(),
            address: None,
            paired_at: chrono::Utc::now().to_rfc3339(),
        })
        .expect("recording a trusted device");
}

fn issue_invite(dir: &Path) -> String {
    let mut invites =
        PendingInvites::load_at(dir.join("invites.json")).expect("a fresh invite store loads");
    let invite = Invite::mint("192.168.1.5:7644", fingerprint(b"inviter"))
        .expect("minting an invite with an address");
    invites.record(&invite).expect("recording the invite");
    invite.secret
}

/// Write an invite whose window closed an hour ago, in the file's own format,
/// so the expiry path is exercised without waiting ten minutes.
fn issue_expired_invite(dir: &Path) -> String {
    let expired = chrono::Utc::now() - chrono::Duration::hours(1);
    let secret = "00112233445566778899aabbccddeeff";
    let payload = serde_json::json!([{
        "secret": secret,
        "address": "192.168.1.5:7644",
        "expires_at": expired.to_rfc3339(),
    }]);
    std::fs::write(
        dir.join("invites.json"),
        serde_json::to_string_pretty(&payload).expect("encoding the invite file"),
    )
    .expect("writing the invite file");
    secret.to_string()
}

#[test]
fn a_machine_that_has_paired_with_nobody_admits_nobody() {
    let dir = tempfile::tempdir().expect("temp dir");
    let gate = TrustGate::in_dir(dir.path());
    assert_eq!(
        gate.admits(&fingerprint(b"a stranger"))
            .expect("reading an empty trust store"),
        Admission::Refused
    );
}

#[test]
fn a_paired_device_is_admitted_by_its_fingerprint() {
    let dir = tempfile::tempdir().expect("temp dir");
    let known = fingerprint(b"the laptop");
    trust_a_device(dir.path(), &known, "laptop");

    let gate = TrustGate::in_dir(dir.path());
    match gate.admits(&known).expect("reading the trust store") {
        Admission::Trusted(device) => assert_eq!(device.name, "laptop"),
        other => panic!("a paired device should be trusted, got {other:?}"),
    }
}

/// The one case where an unrecognised certificate gets anywhere: this machine
/// is currently inviting. It buys the chance to present a secret, nothing else.
#[test]
fn an_unknown_device_reaches_the_pairing_window_only_while_an_invite_is_open() {
    let dir = tempfile::tempdir().expect("temp dir");
    let stranger = fingerprint(b"a stranger");
    let gate = TrustGate::in_dir(dir.path());

    assert_eq!(
        gate.admits(&stranger).expect("no invites yet"),
        Admission::Refused
    );

    issue_invite(dir.path());
    assert_eq!(
        gate.admits(&stranger).expect("an invite is open"),
        Admission::PairingWindow
    );
}

#[test]
fn an_expired_invite_does_not_hold_the_pairing_window_open() {
    let dir = tempfile::tempdir().expect("temp dir");
    issue_expired_invite(dir.path());

    let gate = TrustGate::in_dir(dir.path());
    assert_eq!(
        gate.admits(&fingerprint(b"a stranger"))
            .expect("reading an expired invite"),
        Admission::Refused
    );
}

#[test]
fn a_secret_can_be_spent_exactly_once() {
    let dir = tempfile::tempdir().expect("temp dir");
    let secret = issue_invite(dir.path());
    let gate = TrustGate::in_dir(dir.path());

    assert!(
        gate.consume_secret(&secret).expect("spending the secret"),
        "the first use of a live secret should be accepted"
    );
    assert!(
        !gate
            .consume_secret(&secret)
            .expect("re-spending the secret"),
        "a secret that has been spent must not work a second time"
    );
}

#[test]
fn an_expired_secret_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let secret = issue_expired_invite(dir.path());
    let gate = TrustGate::in_dir(dir.path());
    assert!(
        !gate
            .consume_secret(&secret)
            .expect("spending an old secret"),
        "an invite past its window must not pair anything"
    );
}

#[test]
fn a_secret_nobody_issued_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    issue_invite(dir.path());
    let gate = TrustGate::in_dir(dir.path());
    assert!(
        !gate
            .consume_secret("ffffffffffffffffffffffffffffffff")
            .expect("spending a guessed secret"),
        "a secret this machine never issued must not pair anything"
    );
}

/// Spending one invite must not close the window on another that is still open,
/// which is what a "clear the file" implementation would do.
#[test]
fn spending_one_invite_leaves_another_alone() {
    let dir = tempfile::tempdir().expect("temp dir");
    let first = issue_invite(dir.path());
    let second = issue_invite(dir.path());
    let gate = TrustGate::in_dir(dir.path());

    assert!(gate.consume_secret(&first).expect("spending the first"));
    assert!(gate.consume_secret(&second).expect("spending the second"));
}

#[test]
fn recording_a_pairing_makes_the_next_connection_trusted() {
    let dir = tempfile::tempdir().expect("temp dir");
    let joiner = fingerprint(b"the joiner");
    let gate = TrustGate::in_dir(dir.path());

    assert_eq!(
        gate.admits(&joiner).expect("before pairing"),
        Admission::Refused
    );
    gate.record_pairing(&joiner, "desktop", Some("192.168.1.9:7644".to_string()))
        .expect("recording the pairing");

    match gate.admits(&joiner).expect("after pairing") {
        Admission::Trusted(device) => {
            assert_eq!(device.name, "desktop");
            assert_eq!(device.address.as_deref(), Some("192.168.1.9:7644"));
        }
        other => panic!("a recorded pairing should be trusted, got {other:?}"),
    }
}

/// A device reconnecting from a new address is not a device pairing again, so
/// the date under the "paired" label must not move.
#[test]
fn refreshing_an_address_leaves_the_pairing_date_and_name_alone() {
    let dir = tempfile::tempdir().expect("temp dir");
    let known = fingerprint(b"the laptop");
    let gate = TrustGate::in_dir(dir.path());
    gate.record_pairing(&known, "laptop", Some("192.168.1.5:7644".to_string()))
        .expect("recording the pairing");
    let paired_at = match gate.admits(&known).expect("after pairing") {
        Admission::Trusted(device) => device.paired_at,
        other => panic!("expected a trusted device, got {other:?}"),
    };

    gate.record_address(&known, "192.168.1.9:7644".to_string())
        .expect("refreshing the address");

    match gate.admits(&known).expect("after the refresh") {
        Admission::Trusted(device) => {
            assert_eq!(device.address.as_deref(), Some("192.168.1.9:7644"));
            assert_eq!(device.name, "laptop");
            assert_eq!(device.paired_at, paired_at);
        }
        other => panic!("expected a trusted device, got {other:?}"),
    }
}

/// A device forgotten between the handshake and the address refresh must not be
/// put back by the refresh.
#[test]
fn refreshing_the_address_of_a_forgotten_device_does_not_re_add_it() {
    let dir = tempfile::tempdir().expect("temp dir");
    let gone = fingerprint(b"the laptop");
    let gate = TrustGate::in_dir(dir.path());

    gate.record_address(&gone, "192.168.1.9:7644".to_string())
        .expect("refreshing an address nobody holds");
    assert_eq!(
        gate.admits(&gone).expect("after the refresh"),
        Admission::Refused
    );
}

/// `arterm device forget` has to take effect on the next connection, not on the
/// next restart, which is why the gate reads from disk every time.
#[test]
fn forgetting_a_device_closes_the_door_without_rebuilding_the_gate() {
    let dir = tempfile::tempdir().expect("temp dir");
    let known = fingerprint(b"the laptop");
    trust_a_device(dir.path(), &known, "laptop");
    let gate = TrustGate::in_dir(dir.path());

    assert!(matches!(
        gate.admits(&known).expect("while paired"),
        Admission::Trusted(_)
    ));

    let mut trust =
        TrustStore::load_at(dir.path().join("trusted.json")).expect("loading to forget");
    trust.forget("laptop").expect("forgetting the device");

    assert_eq!(
        gate.admits(&known).expect("after forgetting"),
        Admission::Refused
    );
}

/// Legacy pairings recorded the invite address as the device name (`device
/// join` without `--name`). The handshake hello carries the real name, and
/// `record_name` migrates those placeholder entries on first reconnect.
#[test]
fn learning_a_name_replaces_an_address_shaped_placeholder() {
    let dir = tempfile::tempdir().expect("temp dir");
    let laptop = fingerprint(b"the laptop");
    let gate = TrustGate::in_dir(dir.path());
    gate.record_pairing(
        &laptop,
        "192.168.1.108:7644",
        Some("192.168.1.108:7644".to_string()),
    )
    .expect("recording the legacy pairing");

    let learned = gate
        .record_name(&laptop, "station")
        .expect("learning the name from the hello");
    assert_eq!(learned, "station");

    match gate.admits(&laptop).expect("after learning") {
        Admission::Trusted(device) => {
            assert_eq!(device.name, "station");
            assert_eq!(device.address.as_deref(), Some("192.168.1.108:7644"));
        }
        other => panic!("expected a trusted device, got {other:?}"),
    }
}

/// A name the user chose explicitly is never second-guessed, even when the
/// peer introduces itself with a different one.
#[test]
fn learning_a_name_never_overwrites_a_chosen_name() {
    let dir = tempfile::tempdir().expect("temp dir");
    let laptop = fingerprint(b"the laptop");
    let gate = TrustGate::in_dir(dir.path());
    gate.record_pairing(&laptop, "my-laptop", None)
        .expect("recording the pairing");

    let kept = gate
        .record_name(&laptop, "hostname-says-otherwise")
        .expect("hearing the hello name");
    assert_eq!(kept, "my-laptop");

    match gate.admits(&laptop).expect("after the hello") {
        Admission::Trusted(device) => assert_eq!(device.name, "my-laptop"),
        other => panic!("expected a trusted device, got {other:?}"),
    }
}

/// Address-shaped names take several forms; the detector should catch the ones
/// an invite address can produce and leave real names alone.
#[test]
fn address_shaped_name_detection_covers_the_invite_forms() {
    for placeholder in [
        "192.168.1.108:7644",
        "[fe80::1%3]:7644",
        "[fe80::1]:7644",
        "10.0.0.5",
        "fe80::1",
        "desktop.local:7644",
        "192.168.1.8",
    ] {
        assert!(
            name_looks_like_address(placeholder),
            "{placeholder} should count as address-shaped"
        );
    }
    for chosen in [
        "laptop",
        "my-laptop",
        "station",
        "Toygar's PC",
        "dev box",
        "a:b", // colon present but not a port
    ] {
        assert!(
            !name_looks_like_address(chosen),
            "{chosen} should count as a chosen name"
        );
    }
}

/// A device forgotten between the handshake and the name learning must not be
/// put back by the learning, mirroring the address-refresh rule.
#[test]
fn learning_the_name_of_a_forgotten_device_does_not_re_add_it() {
    let dir = tempfile::tempdir().expect("temp dir");
    let gone = fingerprint(b"the laptop");
    let gate = TrustGate::in_dir(dir.path());

    let learned = gate
        .record_name(&gone, "station")
        .expect("learning a name nobody holds");
    assert!(learned.is_empty());
    assert_eq!(gate.admits(&gone).expect("after the learning"), Admission::Refused);
}
