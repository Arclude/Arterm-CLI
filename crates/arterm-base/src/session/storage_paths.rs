use anyhow::Result;
use std::path::{Path, PathBuf};

use super::PersistVectorMode;
use crate::storage;

pub(crate) fn session_path_in_dir(base: &std::path::Path, session_id: &str) -> PathBuf {
    base.join("sessions").join(format!("{}.json", session_id))
}

pub(super) use crate::process_memory::estimate_json_bytes;

pub(super) fn file_len_or_zero(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

pub(super) fn persist_vector_mode_label(mode: PersistVectorMode) -> &'static str {
    match mode {
        PersistVectorMode::Clean => "clean",
        PersistVectorMode::Append => "append",
        PersistVectorMode::Full => "full",
    }
}

pub fn session_path(session_id: &str) -> Result<PathBuf> {
    let base = storage::arterm_dir()?;
    Ok(session_path_in_dir(&base, session_id))
}

pub fn session_journal_path_from_snapshot(path: &Path) -> PathBuf {
    let mut name = path
        .file_stem()
        .map(|stem| stem.to_os_string())
        .unwrap_or_default();
    name.push(".journal.jsonl");
    path.with_file_name(name)
}

pub fn session_journal_path(session_id: &str) -> Result<PathBuf> {
    Ok(session_journal_path_from_snapshot(&session_path(
        session_id,
    )?))
}

pub fn session_exists(session_id: &str) -> bool {
    session_path(session_id)
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Remove a session's snapshot, journal, and rolling backup from disk.
///
/// Best-effort: used to reclaim throwaway boot sessions after a client moves
/// to another session, so failures are ignored rather than surfaced — the
/// worst case is the pre-fix behaviour (a small file lingers).
pub fn delete_session_files(session_id: &str) {
    let Ok(snapshot) = session_path(session_id) else {
        return;
    };
    delete_session_files_at(&snapshot);
    let _ = crate::storage::unregister_active_pid(session_id);
}

/// Remove a session's artifacts starting from the snapshot path, for callers
/// that discovered the file themselves (e.g., a directory sweep) rather than
/// through the storage-dir id lookup.
pub(crate) fn delete_session_files_at(snapshot: &Path) {
    let journal = session_journal_path_from_snapshot(snapshot);
    // `storage::write_bytes_inner` leaves the previous version as
    // `<id>.bak` (extension replaced, not appended), and a wipe guard can
    // leave `<full-name>.pre-wipe-<ts>.bak` copies. Both are copies of the
    // snapshot being deleted, so both go.
    let rolling_backup = snapshot.with_extension("bak");
    let _ = std::fs::remove_file(snapshot);
    let _ = std::fs::remove_file(&journal);
    let _ = std::fs::remove_file(&rolling_backup);
    if let Some(dir) = snapshot.parent() {
        if let Some(stem) = snapshot.file_name().and_then(|n| n.to_str()) {
            let prefix = format!("{stem}.pre-wipe-");
            let _ = prune_pre_wipe_backups(dir, &prefix);
        }
    }
}

/// Remove `<stem>.pre-wipe-<timestamp>.bak` copies in `dir`.
fn prune_pre_wipe_backups(dir: &std::path::Path, prefix: &str) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(prefix) && name.ends_with(".bak") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}
