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
