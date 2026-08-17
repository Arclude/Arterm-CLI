//! File-level checkpoints: shadow copies taken before any file-mutating
//! tool writes, so a bad edit can be undone without git.
//!
//! Mirrors Cline's checkpoint system: every write captures the pre-edit
//! content (or the fact that the file did not exist), snapshots are
//! session-scoped and ordered, and `undo` restores the most recent one.
//! Unlike git auto-commit, checkpoints are invisible to the user's
//! repository: they live under the arterm state directory.
//!
//! Retention is bounded: a session keeps at most [`MAX_SNAPSHOTS_PER_FILE`]
//! snapshots per file (older ones roll off) and snapshots expire after
//! [`MAX_AGE_SECS`] so the state directory does not grow forever.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Snapshots kept per file, per session. Undo is a one-shot rollback;
/// deeper history belongs to git.
const MAX_SNAPSHOTS_PER_FILE: usize = 5;

/// Snapshots older than this are pruned opportunistically.
const MAX_AGE_SECS: u64 = 7 * 24 * 3600;

/// A poisoned lock is recovered rather than propagated: it means another
/// thread panicked while holding it, and the snapshot map itself is still
/// readable. Panicking here would take the whole process down from inside a
/// tool call, which is a worse outcome than a possibly-stale checkpoint.
/// A checkpoint of one file's pre-edit state.
#[derive(Debug, Clone)]
pub struct Checkpoint {
    /// The file that was (about to be) modified.
    pub file_path: PathBuf,
    /// Pre-edit content. `None` means the file did not exist before the
    /// write that created it; undo deletes the file.
    pub pre_content: Option<Vec<u8>>,
    /// Wall-clock seconds since the epoch, for ordering and expiry.
    pub created_at: u64,
    /// Owning session, for scoping and cleanup.
    pub session_id: String,
}

/// Take a checkpoint of `path` if it exists, or a "file was absent"
/// checkpoint if it does not.
///
/// Returns `None` only when reading an existing file fails; callers should
/// still proceed with the edit in that case (a missing snapshot must never
/// block the tool), but the undo will report the gap.
pub fn snapshot(session_id: &str, path: &Path) -> Option<Checkpoint> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match std::fs::read(path) {
        Ok(bytes) => Some(Checkpoint {
            file_path: path.to_path_buf(),
            pre_content: Some(bytes),
            created_at,
            session_id: session_id.to_string(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Checkpoint {
            file_path: path.to_path_buf(),
            pre_content: None,
            created_at,
            session_id: session_id.to_string(),
        }),
        Err(_) => None,
    }
}

/// In-memory checkpoint registry for a process. Tools record snapshots
/// here; the undo tool pops them.
///
/// The registry is intentionally process-local: checkpoints are a
/// best-effort safety net for the current interactive session, not a
/// durable version-control system. A crash loses the safety net but never
/// user data (snapshots are copies, not moves).
#[derive(Default)]
pub struct CheckpointStore {
    checkpoints: std::sync::Mutex<Vec<Checkpoint>>,
}

impl CheckpointStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a checkpoint (caller has already taken the snapshot).
    pub fn record(&self, cp: Checkpoint) {
        let mut guard = self
            .checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Bound per-file history: drop the oldest snapshots for this file.
        let file = cp.file_path.clone();
        let mut count = guard.iter().filter(|c| c.file_path == file).count();
        while count >= MAX_SNAPSHOTS_PER_FILE {
            if let Some(pos) = guard.iter().position(|c| c.file_path == file) {
                guard.remove(pos);
            } else {
                break;
            }
            count -= 1;
        }
        guard.push(cp);
    }

    /// Take and record a snapshot in one step. Returns whether a snapshot
    /// was recorded.
    pub fn snapshot_and_record(&self, session_id: &str, path: &Path) -> bool {
        match snapshot(session_id, path) {
            Some(cp) => {
                self.record(cp);
                true
            }
            None => false,
        }
    }

    /// Pop and return the most recent checkpoint for `path`, if any.
    pub fn pop_for(&self, path: &Path) -> Option<Checkpoint> {
        let mut guard = self
            .checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pos = guard.iter().rposition(|c| c.file_path == path)?;
        Some(guard.remove(pos))
    }

    /// Pop the most recent checkpoint for `path` owned by `session_id`.
    pub fn pop_for_session(&self, session_id: &str, path: &Path) -> Option<Checkpoint> {
        let mut guard = self
            .checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let pos = guard
            .iter()
            .rposition(|c| c.file_path == path && c.session_id == session_id)?;
        Some(guard.remove(pos))
    }

    /// The most recent checkpoint overall (without removing it).
    pub fn latest(&self) -> Option<Checkpoint> {
        let guard = self
            .checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.last().cloned()
    }

    /// Number of retained checkpoints.
    pub fn len(&self) -> usize {
        self.checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Drop checkpoints older than [`MAX_AGE_SECS`].
    pub fn prune_expired(&self) {
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs()
            .saturating_sub(MAX_AGE_SECS);
        let mut guard = self
            .checkpoints
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|c| c.created_at >= cutoff);
    }
}

/// Process-global checkpoint store shared by the file tools and the undo
/// tool. One process serves one interactive session, so a global is the
/// natural scope.
pub static GLOBAL: std::sync::LazyLock<CheckpointStore> = std::sync::LazyLock::new(|| {
    let store = CheckpointStore::new();
    store.prune_expired();
    store
});

/// Restore a checkpoint: write back the pre-edit content, or delete the
/// file if the checkpoint recorded that it did not exist.
pub fn restore(cp: &Checkpoint) -> std::io::Result<()> {
    match &cp.pre_content {
        Some(bytes) => {
            if let Some(parent) = cp.file_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&cp.file_path, bytes)
        }
        None => match std::fs::remove_file(&cp.file_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str, content: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("arterm-cp-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn snapshot_captures_pre_edit_content() {
        let p = tmp_file("a.txt", "before");
        let cp = snapshot("s1", &p).unwrap();
        assert_eq!(cp.pre_content.as_deref(), Some(b"before".as_slice()));
    }

    #[test]
    fn snapshot_records_absent_file() {
        let p = std::env::temp_dir().join("arterm-cp-test-definitely-absent.txt");
        let cp = snapshot("s1", &p).unwrap();
        assert!(cp.pre_content.is_none());
    }

    #[test]
    fn store_pops_in_lifo_order_per_file() {
        let store = CheckpointStore::new();
        let p = tmp_file("b.txt", "v1");
        store.record(Checkpoint {
            file_path: p.clone(),
            pre_content: Some(b"v1".to_vec()),
            created_at: 1,
            session_id: "s1".into(),
        });
        store.record(Checkpoint {
            file_path: p.clone(),
            pre_content: Some(b"v2".to_vec()),
            created_at: 2,
            session_id: "s1".into(),
        });
        let popped = store.pop_for(&p).unwrap();
        assert_eq!(popped.pre_content.as_deref(), Some(b"v2".as_slice()));
        let popped = store.pop_for(&p).unwrap();
        assert_eq!(popped.pre_content.as_deref(), Some(b"v1".as_slice()));
        assert!(store.pop_for(&p).is_none());
    }

    #[test]
    fn store_bounds_history_per_file() {
        let store = CheckpointStore::new();
        let p = tmp_file("c.txt", "x");
        for i in 0..(MAX_SNAPSHOTS_PER_FILE + 3) {
            store.record(Checkpoint {
                file_path: p.clone(),
                pre_content: Some(vec![i as u8]),
                created_at: i as u64,
                session_id: "s1".into(),
            });
        }
        assert_eq!(store.len(), MAX_SNAPSHOTS_PER_FILE);
        // Oldest dropped: first remaining content is the newest minus bound.
        let popped = store.pop_for(&p).unwrap();
        assert_eq!(
            popped.pre_content.as_deref(),
            Some(&[(MAX_SNAPSHOTS_PER_FILE + 2) as u8][..])
        );
    }

    #[test]
    fn restore_recreates_and_deletes() {
        let p = tmp_file("d.txt", "new content");
        let cp = Checkpoint {
            file_path: p.clone(),
            pre_content: Some(b"old content".to_vec()),
            created_at: 0,
            session_id: "s1".into(),
        };
        restore(&cp).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "old content");

        let absent = p.parent().unwrap().join("created-by-tool.txt");
        let cp_absent = Checkpoint {
            file_path: absent.clone(),
            pre_content: None,
            created_at: 0,
            session_id: "s1".into(),
        };
        std::fs::write(&absent, "tool created").unwrap();
        restore(&cp_absent).unwrap();
        assert!(!absent.exists());
    }

    #[test]
    fn session_scoped_pop() {
        let store = CheckpointStore::new();
        let p = tmp_file("e.txt", "x");
        store.record(Checkpoint {
            file_path: p.clone(),
            pre_content: Some(b"mine".to_vec()),
            created_at: 1,
            session_id: "s1".into(),
        });
        store.record(Checkpoint {
            file_path: p.clone(),
            pre_content: Some(b"theirs".to_vec()),
            created_at: 2,
            session_id: "s2".into(),
        });
        let popped = store.pop_for_session("s1", &p).unwrap();
        assert_eq!(popped.pre_content.as_deref(), Some(b"mine".as_slice()));
        assert!(store.pop_for_session("s1", &p).is_none());
        assert!(store.pop_for_session("s2", &p).is_some());
    }
}
