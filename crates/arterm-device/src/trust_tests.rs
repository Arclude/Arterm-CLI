use super::*;

fn device(fingerprint: &str, name: &str) -> TrustedDevice {
    TrustedDevice {
        fingerprint: fingerprint.to_string(),
        name: name.to_string(),
        address: None,
        paired_at: "2026-08-16T00:00:00Z".to_string(),
    }
}

fn store(dir: &tempfile::TempDir) -> TrustStore {
    TrustStore::load_at(dir.path().join("trusted.json")).expect("load trust store")
}

#[test]
fn a_fresh_installation_trusts_nobody() {
    let dir = tempfile::tempdir().expect("temp dir");
    assert!(store(&dir).devices().is_empty());
}

#[test]
fn trusted_devices_survive_a_reload() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut first = store(&dir);
    first
        .trust(device(&"a".repeat(64), "windows-box"))
        .expect("trust");

    let reloaded = store(&dir);
    assert_eq!(reloaded.devices().len(), 1);
    assert_eq!(reloaded.devices()[0].name, "windows-box");
}

#[test]
fn pairing_the_same_device_again_replaces_rather_than_duplicates() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let fingerprint = "b".repeat(64);

    trust
        .trust(device(&fingerprint, "old-name"))
        .expect("trust");
    trust
        .trust(device(&fingerprint, "new-name"))
        .expect("trust");

    assert_eq!(trust.devices().len(), 1);
    assert_eq!(trust.devices()[0].name, "new-name");
}

#[test]
fn two_devices_sharing_a_name_stay_separate() {
    // Keyed on the fingerprint, not the label: hostnames collide, and letting
    // a collision overwrite a pairing would hand one machine the other's trust.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);

    trust.trust(device(&"c".repeat(64), "desktop")).expect("a");
    trust.trust(device(&"d".repeat(64), "desktop")).expect("b");

    assert_eq!(trust.devices().len(), 2);
}

#[test]
fn forgetting_by_name_and_by_fingerprint_both_work() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let kept = "e".repeat(64);
    let dropped = "f".repeat(64);
    trust.trust(device(&kept, "keep-me")).expect("a");
    trust.trust(device(&dropped, "drop-me")).expect("b");

    let removed = trust.forget("drop-me").expect("forget").expect("was found");
    assert_eq!(removed.fingerprint, dropped);
    assert_eq!(trust.devices().len(), 1);

    let removed = trust.forget(&kept).expect("forget").expect("was found");
    assert_eq!(removed.name, "keep-me");
    assert!(trust.devices().is_empty());

    let reloaded = store(&dir);
    assert!(reloaded.devices().is_empty(), "removal is persisted");
}

#[test]
fn forgetting_accepts_the_fingerprint_exactly_as_device_list_prints_it() {
    // `device list` prints the short grouped uppercase form, so that is the
    // string a person copies into `device forget`. Refusing it -- as this did
    // -- means the tool rejects its own output.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let fingerprint = Fingerprint::of_certificate(b"the other laptop");
    trust
        .trust(device(&fingerprint.to_hex(), "laptop"))
        .expect("trust");

    let printed = fingerprint.to_display();
    let removed = trust.forget(&printed).expect("forget").expect("was found");

    assert_eq!(removed.name, "laptop");
    assert!(store(&dir).devices().is_empty(), "removal is persisted");
}

#[test]
fn a_lookup_accepts_every_spelling_the_tool_prints() {
    // `device connect` and the TUI's peer switch reach the store through the
    // same lookup, so they all gain this at once.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let fingerprint = Fingerprint::of_certificate(b"the other laptop");
    trust
        .trust(device(&fingerprint.to_hex(), "laptop"))
        .expect("trust");

    let grouped = fingerprint.to_display();
    let spellings = [
        grouped.clone(),
        grouped.to_lowercase(),
        grouped.replace('-', ""),
        grouped.replace('-', "").to_lowercase(),
        fingerprint.to_hex(),
        fingerprint.to_hex().to_uppercase(),
        "laptop".to_string(),
    ];
    for spelling in spellings {
        assert!(
            trust.find_by_name_or_fingerprint(&spelling).is_some(),
            "should have found {spelling:?}"
        );
    }
}

#[test]
fn a_fingerprint_prefix_is_not_enough_to_name_a_device() {
    // A lookup takes the first match, so a prefix that happened to fit two
    // paired devices would silently forget or connect to the wrong one.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let fingerprint = Fingerprint::of_certificate(b"the other laptop");
    trust
        .trust(device(&fingerprint.to_hex(), "laptop"))
        .expect("trust");

    let grouped = fingerprint.to_display();
    for partial in [&grouped[..9], &fingerprint.to_hex()[..32]] {
        assert!(
            trust.find_by_name_or_fingerprint(partial).is_none(),
            "should have refused {partial:?}"
        );
    }
}

#[test]
fn a_device_stored_with_an_unparseable_fingerprint_is_still_removable() {
    // Nothing writes one, but a hand-edited store must not trap an entry that
    // cannot be named.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    trust
        .trust(device("not-a-fingerprint", "damaged"))
        .expect("trust");

    assert!(trust.forget("not-a-fingerprint").expect("forget").is_some());
}

#[test]
fn forgetting_something_unknown_reports_nothing_removed() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    assert!(trust.forget("never-paired").expect("forget").is_none());
}

#[test]
fn a_damaged_trust_store_is_an_error_not_an_empty_one() {
    // Reading a corrupt file as "trusts nobody" would look like a working
    // fresh install, and the first symptom would be every pairing silently
    // gone. Fail loudly instead.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("trusted.json");
    std::fs::write(&path, "{ not json").expect("write");

    let error = TrustStore::load_at(path).expect_err("malformed store must fail");
    assert!(error.to_string().contains("malformed"), "{error}");
}

#[test]
fn lookup_matches_on_the_full_fingerprint() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut trust = store(&dir);
    let known = crate::identity::Fingerprint::from_hex(&"1a".repeat(32)).expect("fingerprint");
    let unknown = crate::identity::Fingerprint::from_hex(&"2b".repeat(32)).expect("fingerprint");
    trust
        .trust(device(&known.to_hex(), "paired"))
        .expect("trust");

    assert!(trust.find(&known).is_some());
    assert!(trust.find(&unknown).is_none());
}
