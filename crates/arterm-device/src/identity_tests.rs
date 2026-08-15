use super::*;

#[test]
fn identity_is_minted_once_and_reloads_with_the_same_fingerprint() {
    // The fingerprint is what peers recorded when they paired, so a second
    // load must not quietly mint a new one -- that would break every existing
    // pairing with no visible cause.
    let dir = tempfile::tempdir().expect("temp dir");
    let first = DeviceIdentity::load_or_create_in(dir.path()).expect("mint identity");
    let second = DeviceIdentity::load_or_create_in(dir.path()).expect("reload identity");

    assert_eq!(first.fingerprint(), second.fingerprint());
    assert_eq!(first.certificate_pem(), second.certificate_pem());
    assert_eq!(first.private_key_pem(), second.private_key_pem());
}

#[test]
fn two_installations_get_different_identities() {
    let one = tempfile::tempdir().expect("temp dir");
    let two = tempfile::tempdir().expect("temp dir");

    let a = DeviceIdentity::load_or_create_in(one.path()).expect("mint");
    let b = DeviceIdentity::load_or_create_in(two.path()).expect("mint");

    assert_ne!(a.fingerprint(), b.fingerprint());
}

#[test]
fn fingerprint_is_derived_from_the_certificate_not_stored() {
    // Recomputing from the certificate is what keeps the two from drifting:
    // there is no stored copy that could disagree with the key it describes.
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = DeviceIdentity::load_or_create_in(dir.path()).expect("mint");

    let der = pem_to_der(identity.certificate_pem()).expect("decode pem");
    assert_eq!(identity.fingerprint(), Fingerprint::of_certificate(&der));
}

#[test]
fn fingerprint_round_trips_through_hex() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = DeviceIdentity::load_or_create_in(dir.path()).expect("mint");
    let fingerprint = identity.fingerprint();

    let parsed = Fingerprint::from_hex(&fingerprint.to_hex()).expect("parse hex");
    assert_eq!(fingerprint, parsed);
}

#[test]
fn fingerprint_rejects_wrong_length_rather_than_truncating() {
    // A short value must not be accepted and padded: it would compare equal to
    // a real fingerprint it only shares a prefix with.
    let short = Fingerprint::from_hex("a1b2c3");
    assert!(short.is_err(), "a 3-byte value is not a fingerprint");
    let error = short.expect_err("checked above").to_string();
    assert!(error.contains("32 bytes"), "{error}");

    assert!(
        Fingerprint::from_hex("zzzz").is_err(),
        "non-hex is rejected"
    );
}

#[test]
fn display_form_is_grouped_and_shorter_than_the_verified_value() {
    let dir = tempfile::tempdir().expect("temp dir");
    let identity = DeviceIdentity::load_or_create_in(dir.path()).expect("mint");
    let display = identity.fingerprint().to_display();

    assert_eq!(display.len(), 19, "4 groups of 4 hex chars, 3 separators");
    assert_eq!(display.matches('-').count(), 3);
    assert!(display.len() < identity.fingerprint().to_hex().len());
}

#[test]
fn renaming_keeps_the_fingerprint() {
    // The name is a label; the identity is the key. Renaming a device must not
    // cost its pairings.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut identity = DeviceIdentity::load_or_create_in(dir.path()).expect("mint");
    let before = identity.fingerprint();

    identity
        .set_name_in(dir.path(), "workshop-linux")
        .expect("rename");
    assert_eq!(identity.name(), "workshop-linux");
    assert_eq!(identity.fingerprint(), before);

    let reloaded = DeviceIdentity::load_or_create_in(dir.path()).expect("reload");
    assert_eq!(reloaded.name(), "workshop-linux");
    assert_eq!(reloaded.fingerprint(), before);
}

#[test]
fn empty_name_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut identity = DeviceIdentity::load_or_create_in(dir.path()).expect("mint");
    assert!(identity.set_name_in(dir.path(), "   ").is_err());
}

#[cfg(unix)]
#[test]
fn the_private_key_is_not_world_readable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("temp dir");
    DeviceIdentity::load_or_create_in(dir.path()).expect("mint");

    let mode = std::fs::metadata(dir.path().join("device.key"))
        .expect("key file")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "a readable device key is the whole model gone");
}
