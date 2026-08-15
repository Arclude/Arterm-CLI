//! The configurations themselves. The handshakes they produce are exercised
//! end to end in `tests/peer_handshake.rs`, over real sockets.

use super::*;

fn identity_in(dir: &std::path::Path) -> DeviceIdentity {
    DeviceIdentity::load_or_create_in(dir).expect("minting a device identity")
}

#[test]
fn credentials_carry_the_same_fingerprint_the_identity_reports() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = identity_in(dir.path());
    let credentials = PeerCredentials::from_identity(&identity).expect("reading the identity");

    assert_eq!(credentials.fingerprint(), &identity.fingerprint());
    assert_eq!(credentials.name(), identity.name());
}

/// The fingerprint the wire produces has to be the one the trust store holds.
/// If PEM parsing here disagreed with `Fingerprint::of_certificate` there, every
/// pairing would be recorded under a value no handshake would ever present.
#[test]
fn the_parsed_certificate_hashes_to_the_stored_fingerprint() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = identity_in(dir.path());
    let credentials = PeerCredentials::from_identity(&identity).expect("reading the identity");

    let from_wire = peer_fingerprint(Some(&credentials.chain)).expect("hashing the certificate");
    assert_eq!(from_wire, identity.fingerprint());
}

#[test]
fn both_configurations_build_from_a_real_identity() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = identity_in(dir.path());
    let credentials = PeerCredentials::from_identity(&identity).expect("reading the identity");
    let gate = TrustGate::in_dir(dir.path());

    server_config(&credentials, gate).expect("building the listener configuration");
    client_config(&credentials, identity.fingerprint())
        .expect("building the connection configuration");
}

/// A peer that finished a handshake without a certificate has no identity to
/// check, so there is nothing to fall back to and nothing to guess.
#[test]
fn a_handshake_with_no_certificate_has_no_fingerprint() {
    let error = peer_fingerprint(None).expect_err("no certificate means no identity");
    assert!(
        error
            .to_string()
            .contains("without presenting a certificate"),
        "the error should say what was missing, got: {error}"
    );

    let empty: Vec<CertificateDer<'static>> = Vec::new();
    peer_fingerprint(Some(&empty)).expect_err("an empty chain means no identity");
}

/// Client authentication is not optional. Making it optional would admit a
/// connection there is no way to attribute to any device.
#[test]
fn the_listener_always_demands_a_client_certificate() {
    let dir = tempfile::tempdir().expect("temp dir");
    let verifier = PairedClientVerifier {
        gate: TrustGate::in_dir(dir.path()),
        provider: provider(),
    };
    assert!(verifier.client_auth_mandatory());
    assert!(verifier.offer_client_auth());
    assert!(verifier.root_hint_subjects().is_empty());
}

/// Both verifiers must advertise real schemes: an empty list would leave the
/// handshake with nothing to sign with rather than nothing to check.
#[test]
fn both_verifiers_advertise_the_providers_signature_schemes() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = identity_in(dir.path());
    let expected = provider()
        .signature_verification_algorithms
        .supported_schemes();
    assert!(!expected.is_empty());

    let client_side = PairedClientVerifier {
        gate: TrustGate::in_dir(dir.path()),
        provider: provider(),
    };
    let server_side = PinnedServerVerifier {
        expected: identity.fingerprint(),
        provider: provider(),
    };
    assert_eq!(client_side.supported_verify_schemes(), expected);
    assert_eq!(server_side.supported_verify_schemes(), expected);
}

#[test]
fn the_pinned_verifier_accepts_only_the_fingerprint_it_was_given() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mine = identity_in(dir.path());
    let credentials = PeerCredentials::from_identity(&mine).expect("reading the identity");

    let other_dir = tempfile::tempdir().expect("temp dir");
    let other = identity_in(other_dir.path());

    let verifier = PinnedServerVerifier {
        expected: mine.fingerprint(),
        provider: provider(),
    };
    let name = ServerName::try_from("peer.invalid").expect("a valid name");
    let now = UnixTime::now();

    verifier
        .verify_server_cert(&credentials.chain[0], &[], &name, &[], now)
        .expect("the pinned fingerprint should be accepted");

    let other_credentials = PeerCredentials::from_identity(&other).expect("reading the identity");
    let error = verifier
        .verify_server_cert(&other_credentials.chain[0], &[], &name, &[], now)
        .expect_err("a different device answering must not be accepted");
    assert!(
        error.to_string().contains("refusing rather than trusting"),
        "the error should say why, got: {error}"
    );
}

/// The listener's verifier is the door an unpaired machine hits. It must refuse
/// on an empty trust store and open only once the device is recorded.
#[test]
fn the_listener_verifier_refuses_an_unpaired_certificate() {
    let dir = tempfile::tempdir().expect("temp dir");
    let peer_dir = tempfile::tempdir().expect("temp dir");
    let peer = identity_in(peer_dir.path());
    let peer_credentials = PeerCredentials::from_identity(&peer).expect("reading the identity");

    let verifier = PairedClientVerifier {
        gate: TrustGate::in_dir(dir.path()),
        provider: provider(),
    };
    let now = UnixTime::now();

    let error = verifier
        .verify_client_cert(&peer_credentials.chain[0], &[], now)
        .expect_err("an unpaired certificate must not get through");
    assert!(
        error.to_string().contains("is not paired with this one"),
        "the error should say the device is not paired, got: {error}"
    );

    TrustGate::in_dir(dir.path())
        .record_pairing(&peer.fingerprint(), "peer", None)
        .expect("recording the pairing");
    verifier
        .verify_client_cert(&peer_credentials.chain[0], &[], now)
        .expect("a paired certificate should be accepted");
}
