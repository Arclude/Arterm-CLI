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
fn what_is_printed_is_what_is_accepted() {
    // The property that keeps the printer and the matcher from drifting: every
    // form the tool shows a person must be one the tool answers to. This is the
    // whole bug -- `device list` printed a grouped uppercase value that
    // `device forget` then refused.
    let fingerprint = Fingerprint::of_certificate(b"a device certificate");

    assert!(
        fingerprint.answers_to(&fingerprint.to_display()),
        "the short form `device list` prints"
    );
    assert!(
        fingerprint.answers_to(&fingerprint.to_hex()),
        "the full form `device show` prints"
    );
    assert_ne!(
        Fingerprint::canonical(&fingerprint.to_display()),
        fingerprint.to_display(),
        "the printed form is not already canonical -- were it so, the check above would be vacuous"
    );
}

#[test]
fn a_fingerprint_answers_to_every_spelling_of_itself() {
    let fingerprint = Fingerprint::of_certificate(b"a device certificate");
    let grouped = fingerprint.to_display();
    let full = fingerprint.to_hex();

    let spellings = [
        grouped.clone(),
        grouped.to_lowercase(),
        grouped.replace('-', ""),
        grouped.replace('-', "").to_lowercase(),
        grouped.replace('-', " "),
        grouped.replace('-', ":"),
        alternating_case(&grouped),
        format!("  {grouped}\n"),
        full.clone(),
        full.to_uppercase(),
        alternating_case(&full),
    ];
    for spelling in spellings {
        assert!(
            fingerprint.answers_to(&spelling),
            "should have matched {spelling:?}"
        );
    }
}

#[test]
fn a_fingerprint_does_not_answer_to_something_that_is_merely_close() {
    // Exact on the canonical value, never a prefix: this identifier is what
    // decides which machine is meant.
    let fingerprint = Fingerprint::of_certificate(b"a device certificate");
    let other = Fingerprint::of_certificate(b"a different device certificate");
    let grouped = fingerprint.to_display();
    let full = fingerprint.to_hex();

    let wrong = [
        String::new(),
        "-".to_string(),
        grouped[..9].to_string(),
        grouped[..grouped.len() - 1].to_string(),
        format!("{grouped}-0000"),
        full[..32].to_string(),
        full[..full.len() - 1].to_string(),
        format!("{full}00"),
        "z".repeat(64),
        other.to_display(),
        other.to_hex(),
    ];
    for value in wrong {
        assert!(
            !fingerprint.answers_to(&value),
            "should have refused {value:?}"
        );
    }
}

#[test]
fn a_grouped_full_value_still_parses() {
    // `from_hex` shares the same canonical form, so a value pasted back with
    // its grouping intact is not a parse error.
    let fingerprint = Fingerprint::of_certificate(b"a device certificate");
    let grouped: String = fingerprint
        .to_hex()
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).to_uppercase())
        .collect::<Vec<_>>()
        .join("-");

    assert_eq!(
        Fingerprint::from_hex(&grouped).expect("parse grouped hex"),
        fingerprint
    );
}

/// Upper-cases every other character, the way a value looks after being retyped
/// by hand rather than copied.
fn alternating_case(text: &str) -> String {
    text.chars()
        .enumerate()
        .map(|(index, c)| {
            if index % 2 == 0 {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect()
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
