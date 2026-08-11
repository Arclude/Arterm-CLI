//! Mouse drag-to-select for the transcript.
//!
//! Holds the anchor/cursor cell coordinates for an in-progress mouse selection,
//! maps them to transcript line indices, extracts the selected text in reading
//! order, and copies it to the system clipboard on mouse-up. Mirrors the
//! behaviour of a native terminal's own drag selection: the selected region is
//! drawn with reversed video while dragging, and released to the clipboard on
//! mouse-up.

use crossterm::event::{MouseButton, MouseEventKind};

/// State for an in-progress drag selection.
///
/// Coordinates are in **transcript-cell space** `(row, col)` — that is, the row
/// is a 0-based index into the *visible* transcript lines (after scroll offset
/// has been applied) and the column is a character cell within that line. The
/// caller is responsible for translating the raw crossterm screen coordinates
/// (which include the transcript area offset and scroll state) into this space
/// before calling [`SelectionState::handle_mouse`].
#[derive(Debug, Default, Clone)]
pub struct SelectionState {
    /// The fixed cell where the mouse button went down.
    pub anchor: Option<(u16, u16)>,
    /// The current cell under the mouse cursor (updated while dragging).
    pub cursor: Option<(u16, u16)>,
    /// Whether a drag is currently in progress.
    pub dragging: bool,
}

impl SelectionState {
    /// Returns `true` if a selection region is currently active (anchor and
    /// cursor both set and not equal).
    #[allow(dead_code)]
    pub fn is_active(&self) -> bool {
        match (self.anchor, self.cursor) {
            (Some(a), Some(c)) => a != c,
            _ => false,
        }
    }

    /// Returns `true` between a `Down` and the corresponding `Up`, even if the
    /// selection is still empty (mouse pressed but not dragged).
    #[allow(dead_code)]
    pub fn is_dragging(&self) -> bool {
        self.dragging
    }

    /// Returns the selection as `((start_row, start_col), (end_row, end_col))`
    /// in reading order (top-to-bottom, left-to-right), or `None` if no
    /// selection is active.
    ///
    /// The anchor is the fixed end where the drag began; the cursor is the
    /// moving end. Either may be earlier in reading order than the other.
    pub fn normalized_range(&self) -> Option<((u16, u16), (u16, u16))> {
        let anchor = self.anchor?;
        let cursor = self.cursor?;
        if anchor <= cursor {
            Some((anchor, cursor))
        } else {
            Some((cursor, anchor))
        }
    }

    /// Apply a crossterm mouse event, where `(row, col)` has already been
    /// translated into transcript-cell coordinates.
    ///
    /// - `Down(Left)`: start a new selection at the press point.
    /// - `Drag(Left)`: extend the moving end to the current cell.
    /// - `Up(Left)`: mark the drag as finished; the caller should then extract
    ///   the text and copy it to the clipboard. The selection is *not* cleared
    ///   here so the highlight remains visible during the final draw that
    ///   copies the text; [`SelectionState::clear`] clears it afterwards.
    /// - `ScrollUp` / `ScrollDown`: returns `Scroll(-3)` / `Scroll(3)` so the
    ///   caller can scroll the transcript 3 lines per tick, matching the
    ///   keyboard scroll.
    ///
    /// Other mouse events (right/middle button, moved without button) are
    /// ignored and reported as `Ignored`.
    pub fn handle_mouse(&mut self, row: u16, col: u16, kind: MouseEventKind) -> MouseAction {
        match kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.anchor = Some((row, col));
                self.cursor = Some((row, col));
                self.dragging = true;
                MouseAction::Started
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.dragging {
                    self.cursor = Some((row, col));
                    MouseAction::Updated
                } else {
                    MouseAction::Ignored
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self.dragging {
                    self.cursor = Some((row, col));
                    self.dragging = false;
                    MouseAction::Completed
                } else {
                    MouseAction::Ignored
                }
            }
            MouseEventKind::ScrollUp => MouseAction::Scroll(-3),
            MouseEventKind::ScrollDown => MouseAction::Scroll(3),
            _ => MouseAction::Ignored,
        }
    }

    /// Extract the selected text from the given transcript lines.
    ///
    /// `lines` is the slice of **visible** transcript lines in top-to-bottom
    /// order (exactly the lines rendered on screen). The selection coordinates
    /// index into this slice. Out-of-range coordinates are clamped, so a drag
    /// that overshoots past the last visible line still yields the trailing
    /// text rather than `None`.
    ///
    /// A single-line selection returns the substring between the two columns.
    /// A multi-line selection returns the first line's tail, every full line
    /// in between, and the last line's head, joined by newlines.
    pub fn selected_text(&self, lines: &[String]) -> Option<String> {
        let ((start_row, start_col), (end_row, end_col)) = self.normalized_range()?;
        let line_count = lines.len();
        if line_count == 0 {
            return None;
        }

        // Clamp rows into range. `start_row` may equal `line_count` (an empty
        // selection at the very end), which yields an empty string.
        let s_row = (start_row as usize).min(line_count);
        let e_row = (end_row as usize).min(line_count);
        if s_row >= line_count {
            return None;
        }

        let mut out = String::new();

        if s_row == e_row {
            // Single-line selection.
            let line = &lines[s_row];
            let chars: Vec<char> = line.chars().collect();
            let s = (start_col as usize).min(chars.len());
            let e = (end_col as usize).min(chars.len());
            if s < e {
                out.extend(chars[s..e].iter());
            }
        } else {
            // First line: from start_col to end of line.
            let first = &lines[s_row];
            let first_chars: Vec<char> = first.chars().collect();
            let s = (start_col as usize).min(first_chars.len());
            out.extend(&first_chars[s..]);

            // Full middle lines.
            for line in &lines[s_row + 1..e_row] {
                out.push('\n');
                out.push_str(line);
            }

            // Last line: from start to end_col.
            out.push('\n');
            let last = &lines[e_row];
            let last_chars: Vec<char> = last.chars().collect();
            let e = (end_col as usize).min(last_chars.len());
            out.extend(&last_chars[..e]);
        }

        Some(out).filter(|s| !s.is_empty())
    }

    /// Reset the selection state (anchor, cursor, dragging).
    pub fn clear(&mut self) {
        self.anchor = None;
        self.cursor = None;
        self.dragging = false;
    }
}

/// What [`SelectionState::handle_mouse`] wants the caller to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    /// A new selection started at the press point.
    Started,
    /// The selection was extended to a new cell.
    Updated,
    /// The mouse button was released; the caller should extract and copy the
    /// text, then clear the selection.
    Completed,
    /// A scroll event: scroll the transcript by this many lines (negative =
    /// up).
    Scroll(i32),
    /// The event was not relevant to selection (e.g. right-click, motion with
    /// no button).
    Ignored,
}

// ── Clipboard ───────────────────────────────────────────────────────────

/// Copy `text` to the system clipboard by piping it to the first available
/// clipboard helper command.
///
/// Tries `pbcopy` (macOS), `wl-copy` (Wayland), then `xclip` and `xsel` (X11)
/// in order. The helper is spawned as a child process with `text` written to
/// its stdin; we do not wait for it to finish on the current thread beyond the
/// short time needed to feed stdin, so the UI is not blocked by a slow or
/// missing helper.
///
/// Returns `true` if some helper accepted the text.
pub fn copy_to_clipboard(text: &str) -> bool {
    for (cmd, args) in clipboard_commands() {
        match std::process::Command::new(cmd)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                use std::io::Write;
                if let Some(stdin) = child.stdin.as_mut() {
                    // An error writing to stdin (e.g. the helper exited early
                    // because it couldn't connect to a clipboard daemon) is not
                    // fatal; we still wait for the child so we don't leave a
                    // zombie.
                    let _ = stdin.write_all(text.as_bytes());
                }
                let _ = child.wait();
                return true;
            }
            Err(_) => continue, // command not found; try the next helper
        }
    }
    false
}

/// The ordered list of clipboard helper commands to try.
fn clipboard_commands() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("pbcopy", vec![]),
        ("wl-copy", vec![]),
        ("xclip", vec!["-selection", "clipboard"]),
        ("xsel", vec!["--clipboard", "--input"]),
    ]
}
