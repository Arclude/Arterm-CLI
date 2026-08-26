//! Background maintenance for the on-disk session store.
//!
//! Session transcripts (`<id>.json`) are kept forever, but the atomic-write
//! layer also leaves a single rolling `<id>.bak` next to each file as a
//! crash-recovery copy (see `arterm_storage::write_bytes_inner`). That backup is
//! only ever consulted when the primary `.json` is found to be corrupt on the
//! very next read. For sessions that have not been touched in weeks the primary
//! is stable, so the stale `.bak` is pure disk overhead (these accumulate into
//! gigabytes over time).
//!
//! This module prunes `.bak` files that are older than a conservative window.
//! It never touches the `.json` transcripts themselves, so no session data is
//! lost; at worst a very old, already-stable session loses its redundant
//! recovery copy.
//!
//! It also sweeps long-abandoned empty boot sessions (see
//! [`prune_empty_boot_sessions`]): before the in-band cleanup in
//! `handle_resume_session` landed, every client connect minted a throwaway
//! session file that nothing ever deleted, and installs accumulated thousands
//! of them.

use crate::storage;
use chrono::{DateTime, Duration, Local};
use std::path::Path;

/// Backups older than this are considered safe to remove. Chosen conservatively
/// so any realistic "crashed mid-write, reopened later" scenario still has its
/// recovery copy.
const BACKUP_RETENTION_DAYS: i64 = 30;

/// Minimum interval between prune passes across all arterm processes.
///
/// The prune walks the entire sessions directory (easily 100k+ entries on a
/// long-lived install), which profiles as the single largest CPU cost of TUI
/// startup when it runs unconditionally. Backups only need to be reclaimed
/// eventually, so one pass per interval per machine is plenty; a marker file's
/// mtime coordinates that across concurrently spawned processes.
const PRUNE_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Remove stale `<id>.bak` files from the sessions directory.
///
/// Best-effort: any I/O error is ignored so this can run on a background thread
/// at startup without ever affecting launch. Skips cheaply (one stat) unless
/// the machine-wide prune interval has elapsed, so spawning many arterm
/// processes at once does not trigger many full directory walks.
pub fn prune_old_session_backups() {
    if let Ok(base) = storage::arterm_dir() {
        let sessions_dir = base.join("sessions");
        if !claim_prune_slot(&base) {
            return;
        }
        prune_old_session_backups_in(&sessions_dir, Local::now());
    }
}

/// How old a session must be before the empty-boot sweep may delete it.
///
/// A session younger than this might be a boot session a live client is about
/// to resume away from (the in-band cleanup path in `handle_resume_session`
/// owns that case), or one a user has open and is about to type into. Old and
/// still empty means no client ever came back for it.
const EMPTY_BOOT_RETENTION_DAYS: i64 = 2;

/// Delete long-abandoned empty boot sessions from the sessions directory.
///
/// Before the in-band cleanup landed, every client connect minted a throwaway
/// boot session that was never deleted when the client immediately resumed
/// another one; installs accumulated thousands of these and every picker list
/// showed them. This sweep reclaims that backlog: a session older than
/// [`EMPTY_BOOT_RETENTION_DAYS`] whose transcript holds no visible conversation
/// is provably a boot session nobody returned to.
///
/// Best-effort, same background-thread contract as the backup prune.
pub fn prune_empty_boot_sessions() {
    let Ok(base) = storage::arterm_dir() else {
        return;
    };
    prune_empty_boot_sessions_in(&base.join("sessions"), Local::now());
}

/// Core of [`prune_empty_boot_sessions`], parameterized on the directory and
/// "now" for unit testing.
fn prune_empty_boot_sessions_in(sessions_dir: &Path, now: DateTime<Local>) {
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return;
    };
    let cutoff = now - Duration::days(EMPTY_BOOT_RETENTION_DAYS);
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        // Recency gate first: one stat against the entry we already have.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let modified: DateTime<Local> = modified.into();
        if modified >= cutoff {
            continue;
        }
        // Parse the snapshot before deleting anything: the file must say "no
        // visible conversation", and an unreadable file is left alone.
        let Ok(snapshot) = std::fs::read(&path) else {
            continue;
        };
        if !snapshot_is_empty_boot(&snapshot) {
            continue;
        }
        super::delete_session_files_at(&path);
    }
}

/// Whether a session snapshot's serialized form holds no visible conversation.
///
/// Works on the raw JSON so the sweep does not pay for a full `Session`
/// deserialization per file. Mirrors `Session::has_visible_conversation`
/// exactly: a message is visible when it has no display role, its first text
/// block is not a `<system-reminder>`, and (for user messages) it is not
/// scheduled-task bookkeeping. A file that fails to parse is left alone.
fn snapshot_is_empty_boot(snapshot: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(snapshot) else {
        return false;
    };
    let Some(messages) = value.get("messages").and_then(|m| m.as_array()) else {
        return true;
    };
    messages.iter().all(|message| {
        !json_is_visible_conversation_message(message)
    })
}

/// JSON mirror of `is_visible_conversation_message` (session.rs).
fn json_is_visible_conversation_message(message: &serde_json::Value) -> bool {
    let display_role_none = message
        .get("display_role")
        .map(|r| r.is_null())
        .unwrap_or(true);
    let text_blocks = || {
        message
            .get("content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            })
    };
    // First text block, matching the find_map over ContentBlock::Text.
    let internal_reminder = text_blocks()
        .and_then(|mut blocks| blocks.next())
        .is_some_and(|text| text.trim_start().starts_with("<system-reminder>"));
    let scheduled_task = message.get("role").and_then(|r| r.as_str()) == Some("user")
        && text_blocks()
            .is_some_and(|mut blocks| {
                blocks
                    .any(|text| text.trim_start().starts_with("[Scheduled task]\n"))
            });
    display_role_none && !internal_reminder && !scheduled_task
}

/// Returns true when this process should run the prune pass now, updating the
/// marker so other processes (and future spawns) skip until the next interval.
///
/// The marker touch happens before the walk, so a burst of simultaneous spawns
/// resolves to at most a couple of walkers (racing between the stat and the
/// touch) instead of one per process, and steady-state spawns do a single stat.
fn claim_prune_slot(base: &Path) -> bool {
    let marker = base.join("sessions-bak-prune.stamp");
    if let Ok(metadata) = std::fs::metadata(&marker)
        && let Ok(modified) = metadata.modified()
        && let Ok(age) = std::time::SystemTime::now().duration_since(modified)
        && age.as_secs() < PRUNE_INTERVAL_SECS
    {
        return false;
    }
    // Touch (create or refresh) the marker to claim the slot.
    std::fs::write(&marker, b"").is_ok()
}

/// Core of [`prune_old_session_backups`], parameterized on the directory and
/// "now" for unit testing.
fn prune_old_session_backups_in(sessions_dir: &Path, now: DateTime<Local>) {
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return;
    };
    let cutoff = now - Duration::days(BACKUP_RETENTION_DAYS);
    for entry in entries.flatten() {
        let path = entry.path();
        // Only prune the atomic-write backup files; never the .json transcripts
        // or anything else (journals, tmp files, etc.).
        if path.extension().map(|e| e == "bak").unwrap_or(false)
            && let Ok(metadata) = entry.metadata()
            && metadata.is_file()
            && let Ok(modified) = metadata.modified()
        {
            let modified: DateTime<Local> = modified.into();
            if modified < cutoff {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::time::{Duration as StdDuration, SystemTime};

    #[test]
    fn claim_prune_slot_rate_limits_within_interval_and_reclaims_after() {
        let dir = std::env::temp_dir().join(format!(
            "arterm-bak-claim-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");

        // First claim wins and creates the marker.
        assert!(claim_prune_slot(&dir), "first claim should win");
        let marker = dir.join("sessions-bak-prune.stamp");
        assert!(marker.exists(), "marker should be created");

        // A concurrent/subsequent spawn within the interval is rejected.
        assert!(
            !claim_prune_slot(&dir),
            "second claim within interval should be skipped"
        );

        // Once the marker is older than the interval the slot opens again.
        let old = SystemTime::now() - StdDuration::from_secs(PRUNE_INTERVAL_SECS + 60);
        File::options()
            .write(true)
            .open(&marker)
            .and_then(|f| f.set_modified(old))
            .expect("age the marker");
        assert!(
            claim_prune_slot(&dir),
            "claim should succeed after the interval elapses"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prunes_only_old_bak_files() {
        let dir = std::env::temp_dir().join(format!(
            "arterm-bak-prune-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");

        let write = |name: &str, age_days: u64| {
            let path = dir.join(name);
            let mut f = File::create(&path).expect("create");
            f.write_all(b"{}").ok();
            if age_days > 0 {
                let mtime = SystemTime::now() - StdDuration::from_secs(age_days * 24 * 60 * 60);
                f.set_modified(mtime).expect("set mtime");
            }
            path
        };

        // 60-day-old backup: should be pruned.
        let old_bak = write("session_old.bak", 60);
        // 5-day-old backup: within window, should survive.
        let recent_bak = write("session_recent.bak", 5);
        // Transcripts must never be removed, regardless of age.
        let old_json = write("session_old.json", 60);
        let recent_json = write("session_recent.json", 0);
        // Other artifacts must be left alone.
        let journal = write("session_old.journal.jsonl", 60);

        prune_old_session_backups_in(&dir, Local::now());

        assert!(!old_bak.exists(), "old .bak should be pruned");
        assert!(recent_bak.exists(), "recent .bak must survive");
        assert!(
            old_json.exists(),
            "old .json transcript must never be removed"
        );
        assert!(recent_json.exists(), "recent .json transcript must survive");
        assert!(journal.exists(), "journals are out of scope");

        fs::remove_dir_all(&dir).ok();
    }

    fn boot_sweep_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arterm-boot-sweep-{}-{}-{}",
            tag,
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_session_json(dir: &std::path::Path, session: &super::super::Session) {
        let json =
            serde_json::to_vec(session).expect("serialize session");
        fs::write(dir.join(format!("{}.json", session.id)), json).expect("write session json");
    }

    fn age_file(path: &std::path::Path, age: StdDuration) {
        let old = SystemTime::now() - age;
        File::options()
            .write(true)
            .open(path)
            .and_then(|f| f.set_modified(old))
            .expect("age the file");
    }

    #[test]
    fn snapshot_predicate_matches_session_has_visible_conversation() {
        // The sweep works on raw JSON, so its predicate must agree with the
        // authoritative `Session::has_visible_conversation` on the exact bytes
        // a real `Session::save` produces.
        let cases: Vec<(&str, Vec<super::super::StoredMessage>, bool)> = vec![
            (
                "empty",
                Vec::new(),
                true,
            ),
            (
                "only session context",
                vec![super::super::StoredMessage {
                    id: "m1".into(),
                    role: super::super::Role::User,
                    content: vec![crate::message::ContentBlock::Text {
                        text: "<system-reminder>\n# Session Context\n...\n</system-reminder>"
                            .into(),
                        cache_control: None,
                    }],
                    display_role: Some(super::super::StoredDisplayRole::System),
                    timestamp: None,
                    tool_duration_ms: None,
                    token_usage: None,
                }],
                true,
            ),
            (
                "real user turn",
                vec![super::super::StoredMessage {
                    id: "m2".into(),
                    role: super::super::Role::User,
                    content: vec![crate::message::ContentBlock::Text {
                        text: "hello".into(),
                        cache_control: None,
                    }],
                    display_role: None,
                    timestamp: None,
                    tool_duration_ms: None,
                    token_usage: None,
                }],
                false,
            ),
            (
                "assistant reply",
                vec![super::super::StoredMessage {
                    id: "m3".into(),
                    role: super::super::Role::Assistant,
                    content: vec![crate::message::ContentBlock::Text {
                        text: "hi there".into(),
                        cache_control: None,
                    }],
                    display_role: None,
                    timestamp: None,
                    tool_duration_ms: None,
                    token_usage: None,
                }],
                false,
            ),
        ];
        for (name, messages, expected_empty) in cases {
            let mut session = super::super::Session::create_with_id(
                format!("boot-{name}"),
                None,
                Some("boot".into()),
            );
            session.messages = messages;
            let json = serde_json::to_vec(&session).expect("serialize");
            assert_eq!(
                session.has_visible_conversation(),
                !expected_empty,
                "case {name}: authoritative predicate disagrees with fixture"
            );
            assert_eq!(
                snapshot_is_empty_boot(&json),
                expected_empty,
                "case {name}: JSON predicate disagrees with Session::has_visible_conversation"
            );
        }
    }

    #[test]
    fn boot_sweep_deletes_old_empty_and_keeps_recent_or_conversing() {
        let dir = boot_sweep_dir("mixed");

        // Old empty boot session: swept.
        let old_empty = super::super::Session::create_with_id(
            "old-empty".into(),
            None,
            Some("boot".into()),
        );
        write_session_json(&dir, &old_empty);

        // Old boot session the user actually typed into: kept.
        let mut old_typed = super::super::Session::create_with_id(
            "old-typed".into(),
            None,
            Some("typed boot".into()),
        );
        old_typed.messages.push(super::super::StoredMessage {
            id: "m1".into(),
            role: super::super::Role::User,
            content: vec![crate::message::ContentBlock::Text {
                text: "hello".into(),
                cache_control: None,
            }],
            display_role: None,
            timestamp: None,
            tool_duration_ms: None,
            token_usage: None,
        });
        write_session_json(&dir, &old_typed);

        // Recent empty boot session: a live client may still resume away from
        // it through the in-band path; the sweep leaves it to that path.
        let recent_empty = super::super::Session::create_with_id(
            "recent-empty".into(),
            None,
            Some("boot".into()),
        );
        write_session_json(&dir, &recent_empty);

        age_file(
            &dir.join("old-empty.json"),
            StdDuration::from_secs((EMPTY_BOOT_RETENTION_DAYS as u64 + 1) * 24 * 3600),
        );
        age_file(
            &dir.join("old-typed.json"),
            StdDuration::from_secs((EMPTY_BOOT_RETENTION_DAYS as u64 + 1) * 24 * 3600),
        );

        prune_empty_boot_sessions_in(&dir, Local::now());

        assert!(
            !dir.join("old-empty.json").exists(),
            "old empty boot session must be deleted"
        );
        assert!(
            dir.join("old-typed.json").exists(),
            "boot session with a conversation must be kept"
        );
        assert!(
            dir.join("recent-empty.json").exists(),
            "recent empty boot session must be kept for the in-band path"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn boot_sweep_removes_journal_and_backups_too() {
        let dir = boot_sweep_dir("journal");

        let session = super::super::Session::create_with_id(
            "old-empty-j".into(),
            None,
            Some("boot".into()),
        );
        write_session_json(&dir, &session);
        // Stray artifacts the atomic-write layer or a wipe guard may leave
        // next to the snapshot; deleting the session must remove them too.
        fs::write(dir.join("old-empty-j.bak"), b"{}").expect("write bak");
        fs::write(dir.join("old-empty-j.json.pre-wipe-123.bak"), b"{}")
            .expect("write pre-wipe bak");
        // A journal dir-based file when applicable; use the sibling file form.
        fs::write(dir.join("old-empty-j.journal"), b"{}").expect("write journal");

        age_file(
            &dir.join("old-empty-j.json"),
            StdDuration::from_secs((EMPTY_BOOT_RETENTION_DAYS as u64 + 1) * 24 * 3600),
        );

        // `delete_session_files` resolves paths through the storage dir, so
        // keep the storage env locked while the sweep deletes by path.
        let _env = crate::storage::lock_test_env();

        prune_empty_boot_sessions_in(&dir, Local::now());

        assert!(!dir.join("old-empty-j.json").exists());
        assert!(!dir.join("old-empty-j.bak").exists());
        assert!(
            !dir.join("old-empty-j.json.pre-wipe-123.bak").exists(),
            "pre-wipe backups of a deleted session go too"
        );

        fs::remove_dir_all(&dir).ok();
    }
}
