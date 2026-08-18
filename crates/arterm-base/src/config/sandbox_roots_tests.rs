use super::{Config, expand_sandbox_writable_root};
use std::path::Path;

#[test]
fn sandbox_writable_roots_are_empty_unless_asked_for() {
    // The key grants nothing to anyone who has not written it down, and a
    // config file from before it existed must load exactly as it did.
    assert!(Config::default().sandbox_writable_roots.is_empty());
    let config: Config = toml::from_str("sandbox_mode = \"workspace-write\"\n").expect("parse");
    assert!(config.sandbox_writable_root_paths().is_empty());
}

#[test]
fn a_tilde_sandbox_root_expands_to_the_home_directory() {
    let home = dirs::home_dir().expect("a home directory");
    assert_eq!(
        super::expand_sandbox_writable_root("~/notes"),
        Some(home.join("notes"))
    );
    assert_eq!(super::expand_sandbox_writable_root("~"), Some(home));
}

#[test]
fn another_users_tilde_is_left_alone_rather_than_guessed() {
    // `~other` needs the password database to resolve; guessing would hand out
    // a real directory instead of none, so it stays literal and fails the
    // existence check where it is used.
    assert_eq!(
        super::expand_sandbox_writable_root("~other/notes"),
        Some(Path::new("~other/notes").to_path_buf())
    );
}

#[test]
fn a_relative_sandbox_root_stays_relative_for_the_session_to_resolve() {
    // Resolving it here would resolve it against arterm's own cwd; the session
    // working directory is the only base that means anything to the user.
    assert_eq!(
        super::expand_sandbox_writable_root("build-cache"),
        Some(Path::new("build-cache").to_path_buf())
    );
}

#[test]
fn blank_sandbox_root_entries_are_dropped() {
    let config: Config =
        toml::from_str("sandbox_writable_roots = [\"\", \"  \", \"/opt/shared\"]").expect("parse");
    assert_eq!(
        config.sandbox_writable_root_paths(),
        vec![Path::new("/opt/shared").to_path_buf()]
    );
}

#[test]
fn sandbox_roots_are_written_back_as_typed() {
    // Config saves serialize the whole struct. Storing the expanded path would
    // freeze this machine's home directory into a file that may be synced to
    // another one, so the tilde has to survive a load/save round trip.
    let config: Config = toml::from_str("sandbox_writable_roots = [\"~/notes\"]").expect("parse");
    let rendered = toml::to_string_pretty(&config).expect("serialize");
    assert!(rendered.contains("\"~/notes\""), "{rendered}");
}

#[test]
fn an_empty_sandbox_roots_list_is_not_written_back() {
    let rendered = toml::to_string_pretty(&Config::default()).expect("serialize");
    assert!(
        !rendered.contains("sandbox_writable_roots"),
        "a key nobody set must not appear in a saved config: {rendered}"
    );
}
