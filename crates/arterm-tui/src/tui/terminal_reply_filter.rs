//! Keep a terminal's late answer to the startup color query out of the composer.
//!
//! # The bug this exists for
//!
//! At startup [`crate::tui::theme_detect`] asks the terminal for its background
//! color (OSC 11) and gives it 120 ms to answer, because that query lands on the
//! launch critical path. A terminal that answers *after* the deadline — a
//! multiplexer, an SSH hop, an Electron-hosted xterm.js still doing its first
//! paint — leaves its reply sitting in stdin. By then the TUI owns the terminal,
//! so crossterm decodes those bytes as ordinary keystrokes and the user watches
//! `11;rgb:1c1c/1c1c/1c1c\` type itself into an empty prompt.
//!
//! Widening the timeout only moves the race, and dropping the query costs light
//! terminals their readable palette. So the reply is filtered where it would
//! otherwise become text.
//!
//! # Why hold rather than retract
//!
//! The reply arrives as one burst of char events with sub-millisecond gaps, so
//! candidate characters are held until they either complete a reply (dropped) or
//! stop matching one (released in order, as typed). Holding is bounded twice
//! over: only inside the `GUARD_WINDOW` that follows an unanswered query, and
//! only while the held text is still a prefix of the grammar. Anything else —
//! the first keystroke of real typing, a paste, a multi-char insert — takes the
//! fast path with no state touched at all.
//!
//! [`flush_stale`] is what makes a held prefix safe: the idle tick releases text
//! that stopped arriving, so a lone `1` typed during the guard window appears on
//! the next frame instead of waiting for a second keystroke.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after an unanswered query a reply is still plausibly in flight.
///
/// Terminals that answer at all answer within milliseconds; this covers the slow
/// paths (multiplexer relay, a remote hop, an embedded terminal mid-startup)
/// with room to spare. Generous on purpose: the window starts when the query
/// gives up, which can be a second or more before the composer is even on
/// screen, and the only thing a wide window costs is a `HOLD_TIMEOUT` delay on a
/// character that looks like the start of a reply.
const GUARD_WINDOW: Duration = Duration::from_secs(10);

/// How long a held prefix may wait for the rest of its burst before it is
/// treated as ordinary typing. A terminal emits the whole reply in one write;
/// this is far above that and far below human key-to-key latency.
const HOLD_TIMEOUT: Duration = Duration::from_millis(40);

static STATE: Mutex<Option<GuardState>> = Mutex::new(None);

#[derive(Debug)]
struct GuardState {
    armed_until: Instant,
    held: String,
    held_since: Option<Instant>,
}

/// What a candidate string is, with respect to the color-reply grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// A whole reply. Drop it.
    Complete,
    /// Could still become one. Hold it.
    Prefix,
    /// Cannot become one. Release it.
    No,
}

/// Arm the filter because a background-color query went unanswered and its reply
/// may still land in stdin. Called before the TUI takes the terminal; a second
/// call extends the window rather than starting a new one.
pub fn arm_for_late_color_reply() {
    let Ok(mut state) = STATE.lock() else {
        return;
    };
    *state = Some(GuardState {
        armed_until: Instant::now() + GUARD_WINDOW,
        held: String::new(),
        held_since: None,
    });
    crate::logging::info(
        "Background color query went unanswered; filtering a late reply out of the composer",
    );
}

/// Disarm and drop any held text. For tests, and for the reload handoff, where
/// the inherited terminal has no query in flight.
pub fn disarm() {
    if let Ok(mut state) = STATE.lock() {
        *state = None;
    }
}

/// Decide what a single-character insert should actually insert.
///
/// Returns the text to hand to the composer: the character itself when nothing
/// is being filtered, the released backlog plus the character when a held prefix
/// turns out to be ordinary typing, or `None` when the character was absorbed
/// into a candidate reply.
pub fn filter_insert(text: &str) -> Option<String> {
    // Only the composer's per-key path can carry a decoded reply. Pastes and
    // programmatic inserts arrive whole and are never split into key events.
    if text.chars().count() != 1 {
        return Some(text.to_string());
    }
    let Ok(mut guard) = STATE.lock() else {
        return Some(text.to_string());
    };
    let Some(state) = guard.as_mut() else {
        return Some(text.to_string());
    };
    let now = Instant::now();
    if now >= state.armed_until {
        let released = std::mem::take(&mut state.held);
        *guard = None;
        return Some(released + text);
    }

    let mut candidate = state.held.clone();
    candidate.push_str(text);
    match shape_of(&candidate) {
        Shape::Complete => {
            // The terminal answered late. Swallow the whole reply, and stay
            // armed: colorsaurus can leave a second (OSC 10) reply behind it.
            crate::logging::info(&format!(
                "Swallowed a late terminal color reply ({} chars) before it reached the composer",
                candidate.chars().count()
            ));
            state.held.clear();
            state.held_since = None;
            None
        }
        Shape::Prefix => {
            state.held = candidate;
            state.held_since.get_or_insert(now);
            None
        }
        Shape::No => {
            state.held.clear();
            state.held_since = None;
            Some(candidate)
        }
    }
}

/// Release text that has been held longer than a burst could plausibly last.
///
/// Returns what the composer should insert, if anything. Called from the idle
/// tick so a held character never waits on the next keystroke.
pub fn flush_stale() -> Option<String> {
    let Ok(mut guard) = STATE.lock() else {
        return None;
    };
    let state = guard.as_mut()?;
    if state.held.is_empty() {
        if Instant::now() >= state.armed_until {
            *guard = None;
        }
        return None;
    }
    let held_since = state.held_since?;
    if Instant::now().duration_since(held_since) < HOLD_TIMEOUT {
        return None;
    }
    state.held_since = None;
    let held = std::mem::take(&mut state.held);
    // Terminals that close an OSC with BEL rather than ST leave no character
    // behind to complete the match, so the burst simply stops. A body that only
    // lacks its terminator is still that terminal's answer, not something the
    // user typed in the milliseconds since arterm started.
    if is_full_reply_body(&held) {
        crate::logging::info(&format!(
            "Swallowed an unterminated terminal color reply ({} chars)",
            held.chars().count()
        ));
        return None;
    }
    crate::logging::info(&format!(
        "Released {} held character(s) as ordinary typing",
        held.chars().count()
    ));
    Some(held)
}

/// Whether `s` is a whole reply save for its terminator.
fn is_full_reply_body(s: &str) -> bool {
    matches!(shape_of(&format!("{s}\\")), Shape::Complete)
}

/// Classify a candidate against `]?1[01];rgba?:HHHH/HHHH/HHHH[/HHHH][\]`.
///
/// The leading `]` and the trailing `\` are the halves of the OSC framing that
/// survive crossterm's decoding on some terminals and not others, so both are
/// optional — which is why a reply is only `Complete` once the terminator
/// arrives. Without it the last component is still growing (`1c` -> `1c1c`) and
/// `rgba` may add a fourth, so the burst is judged instead by [`flush_stale`].
fn shape_of(s: &str) -> Shape {
    let s = s.strip_prefix(']').unwrap_or(s);
    if s.is_empty() {
        return Shape::Prefix;
    }

    // The `1[01];` selector: OSC 10 (foreground) or OSC 11 (background).
    let rest = match s.as_bytes() {
        [b'1'] => return Shape::Prefix,
        [b'1', b'0' | b'1'] => return Shape::Prefix,
        [b'1', b'0' | b'1', b';', rest @ ..] => rest,
        _ => return Shape::No,
    };
    let rest = match std::str::from_utf8(rest) {
        Ok(rest) => rest,
        Err(_) => return Shape::No,
    };

    // The `rgb:` / `rgba:` introducer, which may still be arriving.
    match rest.split_once(':') {
        Some(("rgb" | "rgba", components)) => shape_of_components(components),
        Some(_) => Shape::No,
        None if "rgba".starts_with(rest) => Shape::Prefix,
        None => Shape::No,
    }
}

/// Classify the `HHHH/HHHH/HHHH` tail of a reply.
fn shape_of_components(components: &str) -> Shape {
    let (components, terminated) = match components.strip_suffix('\\') {
        Some(head) => (head, true),
        None => (components, false),
    };
    let groups: Vec<&str> = components.split('/').collect();
    if groups.len() > 4 {
        return Shape::No;
    }
    for (i, group) in groups.iter().enumerate() {
        let last = i + 1 == groups.len();
        if group.is_empty() {
            // An empty trailing group is a separator just typed; an empty one in
            // the middle would mean `//`, which the grammar does not allow.
            if last && !terminated {
                return Shape::Prefix;
            }
            return Shape::No;
        }
        if group.len() > 4 || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Shape::No;
        }
    }
    if !terminated {
        // Three components in hand is not the end: the last one is still
        // growing (`1c` -> `1c1c`), and `rgba` adds a fourth. Only the
        // terminator says the reply is over.
        return Shape::Prefix;
    }
    if groups.len() >= 3 {
        Shape::Complete
    } else {
        // A terminator before three components is not this grammar.
        Shape::No
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed a string through the filter one character at a time, as key events
    /// arrive, and return what the composer would have received.
    fn typed(s: &str) -> String {
        let mut out = String::new();
        for c in s.chars() {
            if let Some(text) = filter_insert(&c.to_string()) {
                out.push_str(&text);
            }
        }
        out
    }

    #[test]
    fn unarmed_filter_passes_everything_through() {
        disarm();
        assert_eq!(typed("11;rgb:1c1c/1c1c/1c1c\\"), "11;rgb:1c1c/1c1c/1c1c\\");
    }

    #[test]
    fn armed_filter_swallows_a_late_background_reply() {
        arm_for_late_color_reply();
        assert_eq!(typed("11;rgb:1c1c/1c1c/1c1c\\"), "");
        disarm();
    }

    #[test]
    fn armed_filter_swallows_the_form_that_keeps_its_osc_bracket() {
        arm_for_late_color_reply();
        assert_eq!(typed("]11;rgb:0000/0000/0000\\"), "");
        disarm();
    }

    #[test]
    fn armed_filter_swallows_a_foreground_reply_and_the_background_behind_it() {
        arm_for_late_color_reply();
        assert_eq!(typed("10;rgb:cdcd/d6d6/f4f4\\11;rgb:0000/0000/0000\\"), "");
        disarm();
    }

    #[test]
    fn armed_filter_swallows_a_four_component_reply() {
        arm_for_late_color_reply();
        assert_eq!(typed("11;rgba:1c1c/1c1c/1c1c/ffff\\"), "");
        disarm();
    }

    #[test]
    fn armed_filter_swallows_short_hex_components() {
        arm_for_late_color_reply();
        assert_eq!(typed("11;rgb:1c/1c/1c\\"), "");
        disarm();
    }

    /// A terminal that ends its OSC with BEL sends no character for the
    /// terminator, so the body is only recognizable once the burst stops.
    #[test]
    fn a_bel_terminated_reply_is_dropped_by_the_idle_tick() {
        arm_for_late_color_reply();
        assert_eq!(typed("11;rgb:1c1c/1c1c/1c1c"), "");
        std::thread::sleep(HOLD_TIMEOUT + Duration::from_millis(10));
        assert_eq!(flush_stale(), None, "the body is the reply, not a draft");
        disarm();
    }

    #[test]
    fn ordinary_typing_survives_the_guard_window() {
        arm_for_late_color_reply();
        assert_eq!(typed("hello world"), "hello world");
        disarm();
    }

    #[test]
    fn typing_that_starts_like_a_reply_is_released_in_order() {
        arm_for_late_color_reply();
        assert_eq!(typed("11 files changed"), "11 files changed");
        disarm();
    }

    #[test]
    fn a_near_miss_reply_is_released_rather_than_eaten() {
        arm_for_late_color_reply();
        assert_eq!(typed("11;rgb:zz"), "11;rgb:zz");
        disarm();
    }

    #[test]
    fn multi_char_inserts_bypass_the_filter_entirely() {
        arm_for_late_color_reply();
        assert_eq!(
            filter_insert("11;rgb:1c1c/1c1c/1c1c\\").as_deref(),
            Some("11;rgb:1c1c/1c1c/1c1c\\")
        );
        disarm();
    }

    #[test]
    fn a_held_prefix_is_released_by_the_idle_tick() {
        arm_for_late_color_reply();
        assert_eq!(filter_insert("1"), None, "a bare 1 is a possible prefix");
        assert_eq!(flush_stale(), None, "not yet stale");
        std::thread::sleep(HOLD_TIMEOUT + Duration::from_millis(10));
        assert_eq!(flush_stale().as_deref(), Some("1"));
        assert_eq!(flush_stale(), None, "released only once");
        disarm();
    }

    #[test]
    fn an_expired_guard_releases_what_it_was_holding() {
        arm_for_late_color_reply();
        assert_eq!(filter_insert("1"), None);
        if let Ok(mut guard) = STATE.lock()
            && let Some(state) = guard.as_mut()
        {
            state.armed_until = Instant::now();
        }
        assert_eq!(filter_insert("x").as_deref(), Some("1x"));
        assert_eq!(
            filter_insert("1").as_deref(),
            Some("1"),
            "the guard is gone, so nothing is held any more"
        );
        disarm();
    }

    #[test]
    fn shape_classification() {
        assert_eq!(shape_of("1"), Shape::Prefix);
        assert_eq!(shape_of("11"), Shape::Prefix);
        assert_eq!(shape_of("11;"), Shape::Prefix);
        assert_eq!(shape_of("11;r"), Shape::Prefix);
        assert_eq!(shape_of("11;rgb"), Shape::Prefix);
        assert_eq!(shape_of("11;rgba:"), Shape::Prefix);
        assert_eq!(shape_of("11;rgb:1c1c/"), Shape::Prefix);
        assert_eq!(
            shape_of("11;rgb:1c1c/1c1c/1c1c"),
            Shape::Prefix,
            "the last component can still grow, and rgba adds a fourth"
        );
        assert_eq!(shape_of("11;rgb:1c1c/1c1c/1c1c\\"), Shape::Complete);
        assert_eq!(shape_of("11;rgb:1c1c/1c1c/1c1c/ffff\\"), Shape::Complete);
        assert_eq!(shape_of("12;rgb:1c1c/1c1c/1c1c"), Shape::No);
        assert_eq!(shape_of("11;rgb:1c1c/1c1c\\"), Shape::No);
        assert_eq!(shape_of("11;rgb:1c1c//1c1c"), Shape::No);
        assert_eq!(shape_of("11;rgb:11111/1/1"), Shape::No);
        assert_eq!(shape_of("hello"), Shape::No);
    }
}
