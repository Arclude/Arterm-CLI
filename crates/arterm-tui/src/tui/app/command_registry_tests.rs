//! The slash menu must be the whole list, not a subset someone remembered.
//!
//! `REGISTERED_COMMANDS` is what typing `/` shows and what `/help` prints, but
//! nothing forced it to agree with the commands the dispatcher actually answers
//! to. The two drifted: `/hosted` worked for anyone who already knew it and
//! appeared nowhere. The alias test below it checks a hand-written list, which
//! is the same kind of promise that let `/hosted` through.
//!
//! So this test reads the source instead of a list. Every command literal the
//! TUI compares input against has to be registered, and adding a handler
//! without registering it fails here rather than quietly costing a user the
//! command.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Command literals the TUI dispatches on, as written in its own source.
fn dispatched_command_names() -> BTreeSet<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tui");
    let mut names = BTreeSet::new();
    collect_from_dir(&root, &mut names);
    names
}

fn collect_from_dir(dir: &Path, names: &mut BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_from_dir(&path, names);
            continue;
        }
        let is_rust = path.extension().is_some_and(|ext| ext == "rs");
        // Test files quote commands to exercise them, including ones that are
        // deliberately unknown, so they are not evidence of a real handler.
        let is_test_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("_tests.rs") || name == "tests.rs");
        let in_tests_dir = path.components().any(|part| part.as_os_str() == "tests");
        if is_rust
            && !is_test_file
            && !in_tests_dir
            && let Ok(source) = std::fs::read_to_string(&path)
        {
            collect_from_source(&source, names);
        }
    }
}

/// The three shapes the TUI uses to recognise a command by name.
fn collect_from_source(source: &str, names: &mut BTreeSet<String>) {
    for opener in ["== \"", "starts_with(\"", "strip_prefix(\""] {
        let mut rest = source;
        while let Some(at) = rest.find(opener) {
            rest = &rest[at + opener.len()..];
            if let Some(name) = command_name_at(rest) {
                names.insert(name);
            }
        }
    }
}

/// The command name a literal starts with, if it is one: `/` then lowercase
/// ASCII, dashes allowed, ending at the quote or the first space (a command
/// that takes arguments is matched by its prefix).
fn command_name_at(text: &str) -> Option<String> {
    let body = text.strip_prefix('/')?;
    let name: String = body
        .chars()
        .take_while(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-')
        .collect();
    let terminator = body[name.len()..].chars().next()?;
    if name.is_empty() || !matches!(terminator, '"' | ' ') {
        return None;
    }
    // A bare "/" prefix check is about slash commands in general, not one name.
    Some(format!("/{name}"))
}

#[test]
fn every_command_the_tui_answers_to_is_in_the_menu() {
    let registered: BTreeSet<&str> = super::REGISTERED_COMMANDS
        .iter()
        .map(|command| command.name)
        .collect();

    let missing: Vec<String> = dispatched_command_names()
        .into_iter()
        .filter(|name| !registered.contains(name.as_str()))
        .collect();

    assert!(
        missing.is_empty(),
        "these commands are handled but never appear after typing `/`: {missing:?}\n\
         Add them to REGISTERED_COMMANDS, or use a name the dispatcher does not match on."
    );
}

/// The scan is only worth trusting if it finds things, and a typo in the
/// patterns above would silently make it find nothing.
#[test]
fn the_scan_actually_reads_commands_out_of_the_source() {
    let found = dispatched_command_names();
    assert!(
        found.len() > 50,
        "expected the TUI to dispatch on many commands, found {}: the scan is probably broken",
        found.len()
    );
    assert!(
        found.contains("/memory"),
        "a command known to be dispatched by name was not found by the scan"
    );
}
