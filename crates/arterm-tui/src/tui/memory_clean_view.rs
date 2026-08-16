//! What the `/memory clean` confirmation needs on screen.
//!
//! Its own module because two sides that cannot see each other both need the
//! type: the command builds it from state private to the `app` module, and the
//! renderer reads it from outside that module through the `TuiState` trait.
//! Passing a view rather than the pending state keeps the delete scope out of
//! drawing code entirely.

/// A borrowed snapshot of the armed confirmation.
pub struct MemoryCleanConfirmView<'a> {
    /// Box title, naming the scope being cleaned.
    pub title: &'a str,
    /// Body lines, already worded by the command.
    pub lines: &'a [String],
    /// Whether the destructive choice is the highlighted one. Starts false, so
    /// an absent-minded Enter cancels instead of deleting.
    pub delete_selected: bool,
}
