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

fn device_at(fingerprint: &str, name: &str, address: &str) -> TrustedDevice {
    TrustedDevice {
        fingerprint: fingerprint.to_string(),
        name: name.to_string(),
        address: Some(address.to_string()),
        paired_at: "2026-08-16T00:00:00Z".to_string(),
    }
}

/// Zone-bearing last-known addresses must survive the real trusted.json write
/// path. `TrustedDevice.address` is advisory dial text; stripping `%ifname` or
/// a numeric scope would make the next connect unable to reach link-local
/// peers even though the pairing itself is intact.
#[test]
fn zone_bearing_addresses_survive_trust_store_disk_round_trip() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("trusted.json");

    let bare_ifname = "fe80::a%wlan0:7644";
    let bracket_numeric = "[fe80::b%42]:7644";
    let bare_fp = "a".repeat(64);
    let bracket_fp = "b".repeat(64);

    {
        let mut trust = TrustStore::load_at(path.clone()).expect("loading empty trust store");
        trust
            .trust(device_at(&bare_fp, "bare-zone", bare_ifname))
            .expect("trust bare %ifname");
        trust
            .trust(device_at(&bracket_fp, "bracket-zone", bracket_numeric))
            .expect("trust bracket numeric");
    }

    // Assert against the file on disk first so a pure in-memory clone cannot
    // satisfy the test if save ever started normalising addresses.
    let on_disk = std::fs::read_to_string(&path).expect("reading trusted.json bytes");
    assert!(
        on_disk.contains(bare_ifname),
        "trusted.json must keep bare %ifname zone text verbatim, got:\n{on_disk}"
    );
    assert!(
        on_disk.contains(bracket_numeric),
        "trusted.json must keep bracket numeric zone text verbatim, got:\n{on_disk}"
    );
    assert!(
        on_disk.contains('%'),
        "zone separator must not be stripped from trusted.json, got:\n{on_disk}"
    );

    let reloaded = TrustStore::load_at(path).expect("reloading from disk");
    assert_eq!(reloaded.devices().len(), 2);

    let bare = reloaded
        .find_by_name_or_fingerprint("bare-zone")
        .expect("bare-zone device");
    assert_eq!(
        bare.address.as_deref(),
        Some(bare_ifname),
        "bare %ifname must round-trip through TrustStore save/load"
    );

    let bracket = reloaded
        .find_by_name_or_fingerprint("bracket-zone")
        .expect("bracket-zone device");
    assert_eq!(
        bracket.address.as_deref(),
        Some(bracket_numeric),
        "bracket numeric zone must round-trip through TrustStore save/load"
    );
}
