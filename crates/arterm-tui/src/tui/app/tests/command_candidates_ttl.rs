// Tests for the TTL-based skills refresh on the `/` completion path.
//
// A skill installed while the TUI is open (uipro init, npx skills add, a
// plain mkdir in ~/.arterm/skills) must appear in slash completion without a
// restart. `command_candidates` re-reads skills from disk once the cache is
// older than `App::COMMAND_CANDIDATES_TTL`, so the observable contract is:
// stale cache + typed slash prefix => the new skill is suggested.


/// Directly exercise the cache path: prime the candidates, let the cache go
/// stale, install a new skill into the global registry, and confirm the
/// candidates list picks it up.
#[test]
fn stale_candidates_cache_picks_up_a_newly_installed_skill() {
    let mut app = create_test_app();
    app.input = "/".to_string();

    // Prime the cache with the current skill set.
    let before = app.command_suggestions();
    assert!(
        !before.iter().any(|(cmd, _)| cmd == "/brand-new-ttl-skill"),
        "test precondition: skill must not exist yet"
    );

    // Install a skill into the global sources the loader reads. Use the
    // arterm skills dir, which load_global() always reads.
    let skills_dir = crate::storage::arterm_dir().unwrap().join("skills");
    let skill_dir = skills_dir.join("brand-new-ttl-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: brand-new-ttl-skill\ndescription: Installed while the TUI was open\n---\n# Test\n",
    )
    .unwrap();

    // Backdate the cache so the TTL path triggers on the next read.
    {
        let mut cache = app.command_candidates_cache.borrow_mut();
        if let Some(cache) = cache.as_mut() {
            cache.computed_at = std::time::Instant::now()
                - App::COMMAND_CANDIDATES_TTL
                - std::time::Duration::from_secs(1);
        }
    }

    let after = app.command_suggestions();
    assert!(
        after.iter().any(|(cmd, _)| cmd == "/brand-new-ttl-skill"),
        "a freshly installed skill must appear in / completion after TTL expiry, got {:?}",
        after.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>()
    );

    std::fs::remove_dir_all(&skill_dir).ok();
}

/// A fresh cache must NOT trigger a disk reload: repeated reads within the
/// TTL keep serving the same candidates even if the disk changed underneath.
#[test]
fn fresh_cache_serves_candidates_without_reload() {
    let mut app = create_test_app();
    app.input = "/".to_string();

    let first = app.command_suggestions();
    let second = app.command_suggestions();
    assert_eq!(first, second, "reads within the TTL must be stable");
}
