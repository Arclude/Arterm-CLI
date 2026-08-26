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
    let journal = session_journal_path_from_snapshot(&snapshot);
    let mut backup = snapshot.clone().into_os_string();
    backup.push(".bak");
    let _ = std::fs::remove_file(&snapshot);
    let _ = std::fs::remove_file(&journal);
    let _ = std::fs::remove_file(std::path::Path::new(&backup));
    let _ = crate::storage::unregister_active_pid(session_id);
}
