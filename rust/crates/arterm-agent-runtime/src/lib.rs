//! Runtime primitives the agent loop and the tool layer both need.
//!
//! Kept in its own crate because a tool must be able to observe a cancel
//! without depending on the agent that owns it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// A cancel that can be *read* synchronously and *awaited* asynchronously.
///
/// Both halves are needed: a tool in a tight loop checks [`is_set`](Self::is_set)
/// with no runtime overhead, while a tool blocked on I/O waits on
/// [`cancelled`](Self::cancelled) instead of polling. A signal that only had the
/// flag would force every waiter into a spin loop.
#[derive(Clone)]
pub struct InterruptSignal {
    flag: Arc<AtomicBool>,
    /// Monotonic fire counter. A deferred reset uses it to notice that a
    /// *newer* fire landed in the meantime, so it skips the reset rather than
    /// erasing a cancel its target has not observed yet.
    epoch: Arc<AtomicU64>,
    notify: Arc<tokio::sync::Notify>,
}

impl InterruptSignal {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn fire(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    /// The fire count. Capture it right after a [`fire`](Self::fire) so a later
    /// [`reset_if_epoch`](Self::reset_if_epoch) can undo *that* fire only.
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Reset only if no newer fire happened since `epoch` was captured.
    ///
    /// A fire racing between the check and the store is restored rather than
    /// swallowed: a cancel the user pressed must never be silently erased by a
    /// timer belonging to an older one.
    pub fn reset_if_epoch(&self, epoch: u64) -> bool {
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return false;
        }
        self.flag.store(false, Ordering::SeqCst);
        if self.epoch.load(Ordering::SeqCst) != epoch {
            self.flag.store(true, Ordering::SeqCst);
            self.notify.notify_waiters();
            return false;
        }
        true
    }

    /// Resolves when the signal fires. Returns immediately if it already has —
    /// otherwise a waiter that subscribed a moment too late would hang forever.
    pub async fn cancelled(&self) {
        if self.is_set() {
            return;
        }
        let notified = self.notify.notified();
        // Re-check after subscribing: a fire between the first check and the
        // subscription would otherwise be missed.
        if self.is_set() {
            return;
        }
        notified.await;
    }
}

impl Default for InterruptSignal {
    fn default() -> Self {
        Self::new()
    }
}

/// Where a mid-turn message came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoftInterruptSource {
    User,
    System,
    BackgroundTask,
}

/// Something typed while a turn was already running, waiting for the next point
/// at which it can legally join the conversation.
///
/// It is *not* delivered immediately: every `tool_use` must be answered by its
/// `tool_result` before anything else may appear, so the only legal seam is
/// after a round of results is fully recorded and before the next request goes
/// out. Cancelling the turn instead would throw away the work in flight and
/// re-send the whole prompt.
#[derive(Debug, Clone)]
pub struct SoftInterruptMessage {
    pub content: String,
    pub images: Vec<(String, String)>,
    /// Allowed to cut the remaining tool calls of the current round short.
    pub urgent: bool,
    pub source: SoftInterruptSource,
}

/// The pending soft interrupts. `std::sync::Mutex` on purpose: the UI enqueues
/// from outside the agent's async context and must not have to await it.
pub type SoftInterruptQueue = Arc<std::sync::Mutex<Vec<SoftInterruptMessage>>>;

/// Take everything queued, leaving the queue empty.
///
/// Whatever never landed is handed back to the caller, which is what stops a
/// message typed a moment before the turn ended from being dropped.
pub fn drain_soft_interrupts(queue: &SoftInterruptQueue) -> Vec<SoftInterruptMessage> {
    match queue.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        // A panicked holder must not silently swallow the user's words.
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fire_is_visible_synchronously() {
        let sig = InterruptSignal::new();
        assert!(!sig.is_set());
        sig.fire();
        assert!(sig.is_set());
    }

    #[test]
    fn a_stale_reset_never_erases_a_newer_cancel() {
        let sig = InterruptSignal::new();
        sig.fire();
        let first = sig.epoch();
        // A second cancel lands before the first one's deferred reset runs.
        sig.fire();
        assert!(!sig.reset_if_epoch(first), "the stale reset must decline");
        assert!(sig.is_set(), "the newer cancel must survive");
    }

    #[test]
    fn a_matching_reset_applies() {
        let sig = InterruptSignal::new();
        sig.fire();
        let epoch = sig.epoch();
        assert!(sig.reset_if_epoch(epoch));
        assert!(!sig.is_set());
    }

    #[tokio::test]
    async fn awaiting_an_already_fired_signal_returns_at_once() {
        // A waiter that subscribed after the fire must not hang: the fire has
        // no waiters left to notify.
        let sig = InterruptSignal::new();
        sig.fire();
        sig.cancelled().await;
    }

    #[tokio::test]
    async fn awaiting_wakes_on_a_later_fire() {
        let sig = InterruptSignal::new();
        let waiter = sig.clone();
        let handle = tokio::spawn(async move { waiter.cancelled().await });
        // Yield so the waiter reaches its subscription before the fire.
        tokio::task::yield_now().await;
        sig.fire();
        handle.await.expect("waiter woke");
    }

    #[test]
    fn draining_hands_back_everything_that_never_landed() {
        let queue: SoftInterruptQueue = Arc::new(std::sync::Mutex::new(Vec::new()));
        queue.lock().unwrap().push(SoftInterruptMessage {
            content: "not that file".into(),
            images: Vec::new(),
            urgent: false,
            source: SoftInterruptSource::User,
        });
        let taken = drain_soft_interrupts(&queue);
        assert_eq!(taken.len(), 1);
        // Draining twice must not deliver the same words a second time.
        assert!(drain_soft_interrupts(&queue).is_empty());
    }
}
