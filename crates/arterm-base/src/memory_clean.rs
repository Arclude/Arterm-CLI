//! Deleting stored project memory.
//!
//! The primitives live here, not next to their callers, because two surfaces
//! delete the same files: `arterm memory clean` (CLI) and `/memory clean` (TUI).
//! An irreversible delete implemented twice is an irreversible delete that can
//! disagree with itself, so both call these.
//!
//! Project scope only. Global memory is never touched by anything in this
//! module.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::storage;

/// Directory holding every project's memory store (`<hash>.json`).
pub fn projects_dir() -> Result<PathBuf> {
    Ok(storage::arterm_dir()?.join("memory").join("projects"))
}

/// Remove one store file and every backup of it. Returns whether the store
/// existed. Path-based so it can be tested without moving `ARTERM_HOME`.
pub fn remove_store_at(path: &Path) -> Result<bool> {
    let existed = path.exists();
    if existed {
        std::fs::remove_file(path)
            .with_context(|| format!("removing project memory at {}", path.display()))?;
    }
    for backup in backup_paths(path) {
        if backup.exists() {
            std::fs::remove_file(&backup)
                .with_context(|| format!("removing the backup at {}", backup.display()))?;
        }
    }
    Ok(existed)
}

/// Every file that holds a copy of `path`'s contents.
///
/// A backup is a full copy of what was just deleted, so leaving one means the
/// memory was not really cleared. There are two, written by different layers
/// and easy to mistake for each other:
///
/// - `<hash>.bak` — kept by `storage::write_json` on *every* save, so this is
///   the one that actually exists for a live project. Missing it left a
///   complete copy of "cleaned" memory sitting on disk.
/// - `<hash>.json.bak` — the one-off legacy-format migration backup.
fn backup_paths(path: &Path) -> [PathBuf; 2] {
    [path.with_extension("bak"), path.with_extension("json.bak")]
}

/// Whether `name` is a memory store or a backup of one.
fn is_store_or_backup(name: &str) -> bool {
    name.ends_with(".json") || name.ends_with(".bak")
}

/// Remove every store under `dir` (and every backup of one), returning how
/// many stores were removed. A missing directory is zero, not an error.
pub fn clear_projects_dir(dir: &Path) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("reading project memory directory {}", dir.display()))?
    {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Stores and every backup of them; only stores are counted.
        if is_store_or_backup(name) {
            std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
            if name.ends_with(".json") {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    /// The bug this guards: `storage::write_json` keeps the previous version as
    /// `<hash>.bak` on every save, so that is the backup a real project has.
    /// Deleting only `<hash>.json.bak` left a full copy of "cleaned" memory on
    /// disk — verified against a live store before this was fixed.
    #[test]
    fn removing_a_store_deletes_it_and_every_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("abc.json");
        write(&store, "{}");
        write(&tmp.path().join("abc.bak"), "the storage-layer backup");
        write(&tmp.path().join("abc.json.bak"), "the migration backup");

        assert!(remove_store_at(&store).unwrap());
        assert!(!store.exists());
        assert!(
            !tmp.path().join("abc.bak").exists(),
            "the storage-layer backup is a full copy and must go too"
        );
        assert!(!tmp.path().join("abc.json.bak").exists());
    }

    #[test]
    fn removing_a_missing_store_reports_nothing_was_there() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!remove_store_at(&tmp.path().join("nope.json")).unwrap());
    }

    #[test]
    fn clearing_the_projects_dir_removes_every_store_and_backup() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("one.json"), "{}");
        write(&tmp.path().join("one.bak"), "{}");
        write(&tmp.path().join("one.json.bak"), "{}");
        write(&tmp.path().join("two.json"), "{}");
        // Not a store: must survive, and must not be counted.
        write(&tmp.path().join("README.txt"), "keep me");

        // Two stores, however many backups sat beside them.
        assert_eq!(clear_projects_dir(tmp.path()).unwrap(), 2);
        for gone in ["one.json", "one.bak", "one.json.bak", "two.json"] {
            assert!(!tmp.path().join(gone).exists(), "{gone} must be removed");
        }
        assert!(tmp.path().join("README.txt").exists());
    }

    #[test]
    fn clearing_a_missing_projects_dir_is_zero_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(clear_projects_dir(&tmp.path().join("absent")).unwrap(), 0);
    }
}
