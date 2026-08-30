//! Terminal light/dark theme detection.
//!
//! Resolves the theme mode once per process, before the TUI enters raw mode:
//!
//! 1. `ARTERM_THEME=dark|light` env override (also accepts `auto`).
//! 2. `display.theme` config: "dark", "light", or "auto"/empty.
//! 3. Auto: query the terminal's background color (OSC 11 via
//!    `terminal-colorsaurus`) and classify by perceived lightness. Terminals
//!    known not to support OSC queries are rejected before the bounded query so
//!    they do not add hundreds of milliseconds to startup.
//! 4. Fallback: dark (arterm's native palette).
//!
//! The result is stored in `arterm_tui_style::theme_mode` where the renderer
//! adapts colors for light backgrounds at frame time.

use arterm_tui_style::ThemeMode;
use std::io::IsTerminal;
use std::sync::{Mutex, OnceLock};

static DETECTED: OnceLock<ThemeMode> = OnceLock::new();

/// In-flight prewarm of the (blocking) terminal background query. See
/// [`prewarm_theme_mode`].
static PREWARM: Mutex<Option<std::thread::JoinHandle<ThemeMode>>> = Mutex::new(None);

/// Start resolving the theme mode on a background thread so the OSC 11 round
/// trip overlaps other startup work (notably spawning/awaiting the server)
/// instead of adding its full latency to the critical path.
///
/// Only safe before the terminal enters raw mode and while nothing else reads
/// stdin, because the query writes an escape sequence and consumes the reply.
/// Idempotent, and a no-op once the mode is already resolved.
pub fn prewarm_theme_mode() {
    if DETECTED.get().is_some() {
        return;
    }
    let Ok(mut slot) = PREWARM.lock() else {
        return;
    };
    if slot.is_some() {
        return;
    }
    if let Ok(handle) = std::thread::Builder::new()
        .name("arterm-theme-detect".to_string())
        .spawn(resolve_theme_mode)
    {
        *slot = Some(handle);
    }
}

/// Join a prewarm started by [`prewarm_theme_mode`], if any.
fn take_prewarmed_theme_mode() -> Option<ThemeMode> {
    let handle = PREWARM.lock().ok()?.take()?;
    handle.join().ok()
}

/// Resolve and install the global theme mode. Idempotent; the first call does
/// the (potentially blocking, sub-second) terminal query and later calls are
/// free. Must be called before entering raw mode / the alternate screen.
pub fn init_theme_mode() -> ThemeMode {
    let mode = match take_prewarmed_theme_mode() {
        Some(prewarmed) => *DETECTED.get_or_init(|| prewarmed),
        None => *DETECTED.get_or_init(resolve_theme_mode),
    };
    arterm_tui_style::set_theme_mode(mode);
    init_palette();
    mode
}

/// Resolve the theme while resuming an already-active TUI after an `exec` handoff.
///
/// The inherited terminal is already in raw mode and may already have a crossterm
/// event reader attached. Sending a fresh OSC 11 query in that state can leave the
/// terminal's color response in stdin, where it is decoded as ordinary composer
/// input. Prefer the theme captured by the previous process and otherwise resolve
/// configuration without querying the terminal.
pub fn init_theme_mode_for_resume(inherited_theme: Option<&str>) -> ThemeMode {
    let inherited_theme = inherited_theme.and_then(|value| match value {
        "dark" => Some(ThemeMode::Dark),
        "light" => Some(ThemeMode::Light),
        _ => None,
    });
    // A prewarm may already have queried the terminal; prefer its answer over a
    // second query, but never start one on an inherited raw-mode terminal.
    let prewarmed = take_prewarmed_theme_mode();
    let mode = *DETECTED.get_or_init(|| {
        inherited_theme
            .or(prewarmed)
            .unwrap_or_else(resolve_theme_mode_without_terminal_query)
    });
    arterm_tui_style::set_theme_mode(mode);
    init_palette();
    mode
}

/// Install the user's configured color palette from `[display.colors]`.
///
/// Invalid entries are logged and skipped rather than failing the palette, so
/// one typo can never leave the TUI unstyled. Safe to call repeatedly; the TUI
/// calls it again after `/colors` edits so changes apply without a restart.
pub fn init_palette() {
    let configured = &crate::config::config().display.colors;
    let (palette, errors) = arterm_tui_style::Palette::from_pairs(
        configured
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    );
    for error in errors {
        crate::logging::warn(&format!("display.colors: {error}"));
    }
    arterm_tui_style::set_palette(palette);
}

pub fn current_theme_label() -> &'static str {
    match arterm_tui_style::theme_mode() {
        ThemeMode::Dark => "dark",
        ThemeMode::Light => "light",
    }
}

fn resolve_theme_mode() -> ThemeMode {
    resolve_configured_theme(true)
}

fn resolve_theme_mode_without_terminal_query() -> ThemeMode {
    resolve_configured_theme(false)
}

fn resolve_configured_theme(query_terminal: bool) -> ThemeMode {
    let configured = std::env::var("ARTERM_THEME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| crate::config::config().display.theme.clone());

    match configured.trim().to_ascii_lowercase().as_str() {
        "dark" => return ThemeMode::Dark,
        "light" => return ThemeMode::Light,
        "" | "auto" => {}
        other => {
            crate::logging::info(&format!(
                "Unknown theme '{other}' (expected auto/dark/light); using auto detection"
            ));
        }
    }

    if query_terminal {
        detect_terminal_theme().unwrap_or(ThemeMode::Dark)
    } else {
        crate::logging::info(
            "Skipping terminal background query during reload handoff; preserving a safe theme",
        );
        ThemeMode::Dark
    }
}

/// Query the terminal background color and classify it as dark or light.
/// Returns None when the terminal does not support querying or the query
/// fails, in which case the caller falls back to dark.
fn detect_terminal_theme() -> Option<ThemeMode> {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return None;
    }
    if !terminal_background_query_supported(
        std::env::var("TERM").ok().as_deref(),
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        std::env::var("LC_TERMINAL").ok().as_deref(),
    ) {
        crate::logging::info(
            "Skipping terminal background query for a terminal without OSC query support",
        );
        return None;
    }
    // A terminal that advertises OSC support but never answers costs the full
    // timeout on every single launch. Remember that verdict per terminal
    // identity so only the first launch pays it.
    if silent_terminal_is_cached_at(
        silent_terminal_cache_path().as_deref(),
        &terminal_identity(),
    ) {
        crate::logging::info(
            "Skipping terminal background query for a terminal cached as non-answering",
        );
        return None;
    }
    let mut options = terminal_colorsaurus::QueryOptions::default();
    // Keep startup snappy; supporting terminals answer in a few ms, and
    // colorsaurus detects non-supporting terminals before the timeout anyway.
    // This bound lands on the launch critical path whenever a terminal claims
    // OSC support but never replies (multiplexers, remote shells), so keep it
    // far below the perceptible-stall threshold.
    options.timeout = std::time::Duration::from_millis(120);
    let query_timeout = options.timeout;
    // Ask for only OSC 11. `theme_mode` queries both OSC 10 (foreground) and
    // OSC 11 (background); on some terminals the two replies can be split far
    // enough apart that the query consumes one and crossterm later decodes the
    // other as ordinary keys. That produces composer garbage such as
    // `10;rgb:cdcd/d6d6/f4f4\\11;rgb:0000/0000/0000\\` at startup. Background
    // lightness is all our renderer needs, and a single request has no second
    // reply that can escape into the event reader.
    let mut query = terminal_colorsaurus::background_color(options);
    // A timeout — or an "unsupported terminal" verdict that raced a slow OSC 11
    // behind a fast DA1 — can leave the reply unread on the tty. Wait one grace
    // window in raw mode and consume it, both to keep it from echoing into the
    // shell and to recover the color it carries.
    #[cfg(unix)]
    if query.is_err()
        && let Some(color) = drain_late_color_reply_after_timeout(query_timeout)
    {
        query = Ok(color);
    }
    match query {
        Ok(background) if background.perceived_lightness() > 0.5 => {
            crate::logging::info("Detected light terminal background; adapting theme");
            Some(ThemeMode::Light)
        }
        Ok(_) => Some(ThemeMode::Dark),
        Err(e) => {
            // Both of these verdicts mean "this terminal will never give us a
            // timely color": a pure timeout, and the DA1-race where DA1 answers
            // fast while OSC 11 never lands inside the window. Remember either
            // one so subsequent launches skip the query (and its escape-sequence
            // debris) entirely.
            if matches!(
                e,
                terminal_colorsaurus::Error::Timeout(_)
                    | terminal_colorsaurus::Error::UnsupportedTerminal(_)
            ) {
                cache_silent_terminal_at(
                    silent_terminal_cache_path().as_deref(),
                    &terminal_identity(),
                );
            }
            // A late reply may still be in flight. The drain above already tried
            // to consume it while raw mode suppressed the echo; if bytes slipped
            // past it they would be decoded as typing: `11;rgb:1c1c/1c1c/1c1c\`
            // appearing in an empty composer at startup, so also arm the filter
            // that swallows them.
            crate::tui::terminal_reply_filter::arm_for_late_color_reply();
            crate::logging::info(&format!(
                "Terminal background detection unavailable ({e}); defaulting to dark theme"
            ));
            None
        }
    }
}

/// Consume a terminal color reply left unread by a failed color query.
///
/// `terminal_colorsaurus` gives up on its deadline or when its DA1 feature
/// probe outraces a slow color answer, and either way a reply can still land
/// afterwards. Once the process leaves raw mode the kernel echoes those bytes,
/// printing garbage like `^[]11;rgb:0909/0b0b/0c0c^[\` into the shell after
/// arterm exits. Re-enter raw mode briefly and keep polling for anything that
/// arrives within a short grace window, discarding it before it can echo.
///
/// Best-effort: when nothing arrives within the grace window we stop, and the
/// in-TUI reply filter remains the safety net for a later straggler. When a
/// reply does land, it is parsed and returned so the caller can still use the
/// color instead of treating the terminal as silent.
#[cfg(unix)]
fn drain_late_color_reply_after_timeout(
    query_timeout: std::time::Duration,
) -> Option<terminal_colorsaurus::Color> {
    use std::io::Read as _;

    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return None;
    }

    let Ok(mut terminal) = terminal_trx::terminal() else {
        return None;
    };
    let mut lock = terminal.lock();
    let Ok(mut raw) = lock.enable_raw_mode() else {
        return None;
    };

    // The reply needed more than the original timeout to land, so give it the
    // same amount again, capped: a reply that only lands after several grace
    // windows would already have been disruptive, and the verdict gets cached
    // so at most one launch pays for it.
    let grace = query_timeout
        .saturating_mul(2)
        .min(std::time::Duration::from_millis(500));
    let deadline = std::time::Instant::now() + grace;
    let mut scratch = [0u8; 128];
    let mut drained = Vec::new();
    while std::time::Instant::now() < deadline {
        if !poll_readable(&raw, std::time::Duration::from_millis(50)) {
            if !drained.is_empty() {
                // Drained a burst; a quiet slice after it means the reply is done.
                break;
            }
            continue;
        }
        match raw.read(&mut scratch) {
            Ok(0) => break,
            Ok(n) => drained.extend_from_slice(&scratch[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
        if let Some(color) = parse_late_color_reply(&drained) {
            crate::logging::info(
                "Recovered a terminal color reply that arrived after the query timeout",
            );
            return Some(color);
        }
    }
    if !drained.is_empty() {
        crate::logging::info("Discarded terminal bytes that arrived after the query timeout");
    }
    // Guards drop here: raw mode off first, then the terminal lock, restoring
    // the modes colorsaurus left behind.
    None
}

/// Extract an OSC 11 color from bytes drained off the tty.
///
/// Terminals wrap the reply as `ESC ] 11 ; <spec> (ST | BEL)`; parse the spec
/// with the same X11 parser colorsaurus uses so the recovered value is
/// indistinguishable from an on-time answer.
#[cfg(unix)]
fn parse_late_color_reply(drained: &[u8]) -> Option<terminal_colorsaurus::Color> {
    // Tolerate a leading DA1 reply (`ESC[c`) from the feature-detection probe
    // that may precede the color answer in the same drained buffer.
    let start = drained
        .windows(4)
        .position(|w| w == b"\x1b]11")
        .map(|i| i + 4)?;
    let rest = &drained[start..];
    let mut spec = rest.split(|&b| b == b'\x07' || b == b'\x1b');
    let spec = spec.next()?;
    let spec = spec.strip_prefix(b";")?;
    let color = xterm_color::Color::parse(spec).ok()?;
    Some(terminal_colorsaurus::Color::rgb(
        color.red,
        color.green,
        color.blue,
    ))
}

/// Wait until `readable` reports data (or an error/hangup) is available.
/// Returns false on timeout or when polling is unavailable on this platform.
fn poll_readable(readable: &impl std::os::fd::AsRawFd, slice: std::time::Duration) -> bool {
    let mut pfd = libc::pollfd {
        fd: readable.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let timeout_ms = slice.as_millis().min(i32::MAX as u128) as libc::c_int;
    (unsafe { libc::poll(&mut pfd, 1, timeout_ms) }) > 0
}

/// Identity of the terminal we are talking to, for caching purposes. Keep it
/// coarse: the emulator identity, not the individual window or session.
fn terminal_identity() -> String {
    let value = |name: &str| std::env::var(name).unwrap_or_default();
    format!(
        "{}|{}|{}",
        value("TERM"),
        value("TERM_PROGRAM"),
        value("LC_TERMINAL")
    )
}

fn silent_terminal_cache_path() -> Option<std::path::PathBuf> {
    Some(
        crate::storage::arterm_dir()
            .ok()?
            .join("cache")
            .join("osc11-silent-terminals"),
    )
}

/// Longest cache we keep, so an upgraded or reconfigured terminal that gains
/// OSC support is re-probed instead of being written off forever.
const SILENT_TERMINAL_CACHE_TTL: std::time::Duration =
    std::time::Duration::from_secs(60 * 60 * 24 * 7);

/// Cap on remembered terminal identities. This is a cache, not a record.
const SILENT_TERMINAL_CACHE_MAX: usize = 32;

fn silent_terminal_is_cached_at(path: Option<&std::path::Path>, identity: &str) -> bool {
    let Some(path) = path else {
        return false;
    };
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };
    if modified
        .elapsed()
        .is_ok_and(|age| age > SILENT_TERMINAL_CACHE_TTL)
    {
        return false;
    }
    let Ok(contents) = std::fs::read_to_string(path) else {
        return false;
    };
    contents.lines().any(|line| line == identity)
}

fn cache_silent_terminal_at(path: Option<&std::path::Path>, identity: &str) {
    let Some(path) = path else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|line| line == identity) {
        // Re-touch the cache so the TTL window restarts: a terminal that is
        // still not answering today should not expire into a launch-timeout
        // every 7 days just because it was written down once and never moved.
        let _ = std::fs::write(path, existing);
        return;
    }
    let mut kept: Vec<&str> = existing
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(SILENT_TERMINAL_CACHE_MAX - 1)
        .collect();
    kept.reverse();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(identity);
    out.push('\n');
    let _ = std::fs::write(path, out);
}

/// Reject terminal classes that cannot answer OSC 11 before entering the
/// colorsaurus timeout path. A concrete terminal-program hint wins because
/// launchers and multiplexers occasionally leave a conservative `TERM` value
/// in place even though the outer emulator supports OSC queries.
fn terminal_background_query_supported(
    term: Option<&str>,
    term_program: Option<&str>,
    lc_terminal: Option<&str>,
) -> bool {
    if term_program.is_some_and(|value| !value.trim().is_empty())
        || lc_terminal.is_some_and(|value| !value.trim().is_empty())
    {
        return true;
    }

    let term = term.unwrap_or("").trim().to_ascii_lowercase();
    !matches!(term.as_str(), "" | "dumb" | "linux" | "cons25" | "emacs")
}

#[cfg(test)]
mod tests {
    use super::{
        SILENT_TERMINAL_CACHE_MAX, cache_silent_terminal_at, silent_terminal_is_cached_at,
        terminal_background_query_supported,
    };

    #[cfg(unix)]
    #[test]
    fn parses_a_st_terminated_late_osc11_reply() {
        let reply = b"\x1b]11;rgb:0909/0b0b/0c0c\x1b\\";
        let color = super::parse_late_color_reply(reply).unwrap();
        assert_eq!(color.scale_to_8bit(), (0x09, 0x0b, 0x0c));
    }

    #[cfg(unix)]
    #[test]
    fn parses_a_bel_terminated_late_osc11_reply() {
        let reply = b"\x1b]11;rgb:ffff/ffff/ffff\x07";
        let color = super::parse_late_color_reply(reply).unwrap();
        assert!(color.perceived_lightness() > 0.5);
    }

    #[cfg(unix)]
    #[test]
    fn parses_a_reply_preceded_by_a_da1_response() {
        let reply = b"\x1b[?1;2c\x1b]11;rgb:1c1c/1c1c/1c1c\x1b\\";
        assert!(super::parse_late_color_reply(reply).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn ignores_drained_bytes_that_are_not_a_color_reply() {
        assert!(super::parse_late_color_reply(b"\x1b[?1;2c").is_none());
        assert!(super::parse_late_color_reply(b"garbage").is_none());
    }

    #[test]
    fn recaching_a_silent_terminal_refreshes_the_ttl_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("osc11-silent-terminals");

        cache_silent_terminal_at(Some(&path), "xterm-256color||");
        // Backdate the entry past the TTL so only a refreshed mtime keeps it
        // alive, then re-cache the same identity like a later launch would.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60 * 24 * 30);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(!silent_terminal_is_cached_at(
            Some(&path),
            "xterm-256color||"
        ));

        cache_silent_terminal_at(Some(&path), "xterm-256color||");
        assert!(silent_terminal_is_cached_at(
            Some(&path),
            "xterm-256color||"
        ));
    }

    #[test]
    fn skips_terminals_without_osc_query_support() {
        for term in [None, Some(""), Some("dumb"), Some("linux"), Some("cons25")] {
            assert!(!terminal_background_query_supported(term, None, None));
        }
    }

    #[test]
    fn queries_terminal_emulators_and_honors_program_hints() {
        assert!(terminal_background_query_supported(
            Some("xterm-256color"),
            None,
            None
        ));
        assert!(terminal_background_query_supported(
            Some("linux"),
            Some("kitty"),
            None
        ));
        assert!(terminal_background_query_supported(
            Some("linux"),
            None,
            Some("iTerm2")
        ));
    }

    #[test]
    fn caches_a_non_answering_terminal_so_only_the_first_launch_pays_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache").join("osc11-silent-terminals");

        assert!(!silent_terminal_is_cached_at(Some(&path), "xterm|kitty|"));
        cache_silent_terminal_at(Some(&path), "xterm|kitty|");
        assert!(silent_terminal_is_cached_at(Some(&path), "xterm|kitty|"));
        // A different terminal must still be probed.
        assert!(!silent_terminal_is_cached_at(Some(&path), "xterm|wezterm|"));
    }

    #[test]
    fn silent_terminal_cache_is_bounded_and_keeps_the_newest_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("osc11-silent-terminals");
        for i in 0..(SILENT_TERMINAL_CACHE_MAX * 2) {
            cache_silent_terminal_at(Some(&path), &format!("term-{i}||"));
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().filter(|l| !l.is_empty()).collect();
        assert!(lines.len() <= SILENT_TERMINAL_CACHE_MAX, "{}", lines.len());
        let newest = format!("term-{}||", SILENT_TERMINAL_CACHE_MAX * 2 - 1);
        assert!(silent_terminal_is_cached_at(Some(&path), &newest));
    }

    #[test]
    fn missing_cache_path_never_skips_the_query() {
        assert!(!silent_terminal_is_cached_at(None, "xterm||"));
        // Must not panic when there is nowhere to write.
        cache_silent_terminal_at(None, "xterm||");
    }
}
