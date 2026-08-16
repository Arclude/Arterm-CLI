use super::*;

#[test]
fn removing_a_store_deletes_it_and_its_backup() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = dir.path().join("abc123.json");
    let backup = dir.path().join("abc123.json.bak");
    std::fs::write(&store, "{}").expect("write store");
    std::fs::write(&backup, "{}").expect("write backup");

    assert!(
        remove_store_at(&store).expect("remove"),
        "the store was there"
    );
    assert!(!store.exists(), "store is gone");
    assert!(
        !backup.exists(),
        "the backup is gone too, or memory was not really cleared"
    );
}

#[test]
fn removing_a_missing_store_reports_nothing_was_there() {
    let dir = tempfile::tempdir().expect("temp dir");
    assert!(!remove_store_at(&dir.path().join("never.json")).expect("remove"));
}

#[test]
fn clearing_the_projects_dir_removes_every_store_and_backup() {
    let dir = tempfile::tempdir().expect("temp dir");
    for hash in ["1111", "2222", "3333"] {
        std::fs::write(dir.path().join(format!("{hash}.json")), "{}").expect("store");
        std::fs::write(dir.path().join(format!("{hash}.json.bak")), "{}").expect("bak");
    }
    // Something that is not a project store must be left alone.
    std::fs::write(dir.path().join("index.json.keep"), "x").expect("other");

    let removed = clear_projects_dir(dir.path()).expect("clear");
    assert_eq!(removed, 3, "counts stores, not backups");

    let left: Vec<_> = std::fs::read_dir(dir.path())
        .expect("read")
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        left,
        vec!["index.json.keep".to_string()],
        "only the non-store file survives"
    );
}

#[test]
fn clearing_a_missing_projects_dir_is_zero_not_an_error() {
    let dir = tempfile::tempdir().expect("temp dir");
    assert_eq!(
        clear_projects_dir(&dir.path().join("no-such-projects")).expect("clear"),
        0
    );
}
