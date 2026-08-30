//! Tests for the run loop.
//!
//! Split out of `run_shell.rs` so that file can stay under the code-size
//! ratchet; the repo already uses this `#[path]` pattern.

/// The regression that made the animation lag: an idle screen almost always
/// has some slow-moving chrome up (notification line, status notice, cache
/// countdown). If that chrome wins every tick, the animation runs at full
/// frame cost. It must instead get a full frame only at its own cadence,
/// with the animation frames in between served cheaply.
/// The animation-only path reuses the previous full frame for everything
/// outside the decorative rows, so it can never show a newer input line. It
/// must therefore refuse to run while the composer differs from what the last
/// full frame drew.
///
/// Without this, a keystroke's redraw request was "satisfied" by an animation
/// frame that did not contain the character, and the glyph waited for a later
/// full frame. Measured against a live client, typing echoed to the terminal
/// in ~7ms but only reached the screen ~500ms later; with the guard the same
/// keystroke paints in ~6ms.
///
/// Every existing test missed this because they render single frames and
/// compare pixels: the partial frame is *correct*, it is simply the wrong
/// frame to have drawn, which is only visible across frames over time.
#[test]
fn the_animation_only_path_refuses_to_run_when_the_composer_changed() {
    // Pretend a full frame drew an empty composer.
    // Struct update so a new renderer field cannot break this test.
    let renderer = StatusSpinnerRenderer {
        last_frame: Some(Buffer::empty(Rect::new(0, 0, 10, 3))),
        ..Default::default()
    };

    // Same input: the guard must not object (other predicates may still
    // block, which is why this asserts the reason rather than the outcome).
    assert!(
        !renderer.composer_changed_since_last_full_frame(""),
        "an unchanged composer must not block the cheap path"
    );

    // A keystroke landed. The path cannot render it, so it must be blocked.
    assert!(
        renderer.composer_changed_since_last_full_frame("/"),
        "a typed character must force a full frame"
    );
}

/// Invalidation must clear the remembered input too. A stale value would let
/// the animation-only path run against a frame that no longer exists.
#[test]
fn invalidating_the_renderer_forgets_the_drawn_composer() {
    let mut renderer = StatusSpinnerRenderer {
        last_full_frame_input: "draft".to_string(),
        ..Default::default()
    };
    renderer.invalidate();
    assert!(
        renderer.composer_changed_since_last_full_frame("draft"),
        "after invalidation nothing is known to be drawn, so any composer \
         contents must force a full frame"
    );
}

use super::*;
use ratatui::style::Color;

#[tokio::test]
async fn redraw_timer_waits_one_period_and_skips_missed_ticks() {
    let mut timer = redraw_timer(Duration::from_millis(250));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), timer.tick())
            .await
            .is_err(),
        "the first redraw tick must not fire immediately"
    );
    assert_eq!(
        timer.missed_tick_behavior(),
        tokio::time::MissedTickBehavior::Skip
    );
}

fn assert_duration_close(actual: Duration, expected: Duration) {
    let actual_ms = actual.as_millis() as i128;
    let expected_ms = expected.as_millis() as i128;
    assert!(
        (actual_ms - expected_ms).abs() <= 1,
        "expected {actual:?} to be within 1ms of {expected:?}"
    );
}

#[test]
fn status_spinner_fast_path_uses_status_elapsed_clock() {
    let full_status_elapsed = 0.0;
    let app_lifetime_elapsed = 0.24;

    let full_status_symbol =
        arterm_tui_style::theme::activity_indicator(full_status_elapsed, STATUS_SPINNER_FPS, true);
    let old_app_lifetime_symbol =
        arterm_tui_style::theme::activity_indicator(app_lifetime_elapsed, STATUS_SPINNER_FPS, true);
    let fast_path_symbol = arterm_tui_style::theme::activity_indicator(
        status_spinner_elapsed_for_sources(Some(full_status_elapsed)),
        STATUS_SPINNER_FPS,
        true,
    );

    assert_ne!(
        old_app_lifetime_symbol, full_status_symbol,
        "the app lifetime clock can be on a different spinner frame than the status clock"
    );
    assert_eq!(fast_path_symbol, full_status_symbol);
}

#[test]
fn primary_spinner_statuses_are_explicit() {
    assert!(status_uses_primary_spinner(&ProcessingStatus::Sending));
    assert!(status_uses_primary_spinner(&ProcessingStatus::Streaming));
    assert!(!status_uses_primary_spinner(
        &ProcessingStatus::RunningTool("bash".to_string())
    ));
    assert!(!status_uses_primary_spinner(&ProcessingStatus::Idle));
    assert!(!status_uses_primary_spinner(
        &ProcessingStatus::WaitingForNetwork {
            listener: "network".to_string(),
        }
    ));
}

#[test]
fn slash_command_palette_suspends_spinner_fast_path() {
    assert!(is_slash_command_input("/"));
    assert!(is_slash_command_input("  /help"));
    assert!(!is_slash_command_input("normal prompt"));
}

/// The palette predicate must short-circuit on the input prefix so hot
/// paths never build the suggestion list for ordinary prompts.
#[test]
fn palette_visibility_checks_the_cheap_prefix_before_building_suggestions() {
    let mut suggestions_built = false;
    assert!(!slash_command_palette_may_be_visible("hello", || {
        suggestions_built = true;
        true
    }));
    assert!(
        !suggestions_built,
        "non-slash input must not pay for the suggestion list"
    );

    assert!(slash_command_palette_may_be_visible("/", || true));
    assert!(!slash_command_palette_may_be_visible("/", || false));
}

/// The bug this pins: on a fresh idle screen (donut spinning), pressing `/`
/// opens the command palette, which floats over the animation rows. Full
/// frames painted the palette, then the very next animation-only repaint
/// reset those rows and erased it, so the menu blinked in and out at the
/// chrome full-frame cadence (~4 Hz), captured frame-by-frame from a live
/// tester PTY. While the palette may be visible, animation ticks must take
/// the full-frame path, which re-renders the overlay.
#[test]
fn the_animation_only_path_refuses_to_run_while_the_command_palette_is_up() {
    let clean_idle_frame = IdleAnimationFastPathInputs {
        has_previous_frame: true,
        animation_active: true,
        has_animation_area: true,
        force_full_redraw: false,
        force_full_repaint: false,
        composer_changed: false,
        command_palette_visible: false,
    };
    assert_eq!(
        idle_animation_fast_path_blocked_reason(&clean_idle_frame),
        None,
        "a clean idle frame must keep the cheap path available"
    );

    let palette_open = IdleAnimationFastPathInputs {
        command_palette_visible: true,
        ..clean_idle_frame
    };
    assert_eq!(
        idle_animation_fast_path_blocked_reason(&palette_open),
        Some("command_palette_visible"),
        "an open palette must force full frames so the overlay survives"
    );

    // A keystroke that both changes the composer and opens the palette
    // reports the keystroke: it is the more urgent of the two reasons.
    let typing_into_palette = IdleAnimationFastPathInputs {
        composer_changed: true,
        command_palette_visible: true,
        ..clean_idle_frame
    };
    assert_eq!(
        idle_animation_fast_path_blocked_reason(&typing_into_palette),
        Some("input_changed"),
    );
}

#[test]
fn status_spinner_reset_targets_next_frame_boundary() {
    assert_duration_close(
        status_spinner_delay_until_next_frame(0.0),
        STATUS_SPINNER_ONLY_INTERVAL,
    );
    assert_duration_close(
        status_spinner_delay_until_next_frame(0.040),
        Duration::from_millis(40),
    );
    assert_duration_close(
        status_spinner_delay_until_next_frame(1.0),
        Duration::from_millis(40),
    );
    assert_duration_close(
        status_spinner_delay_until_next_frame(f32::NAN),
        STATUS_SPINNER_ONLY_INTERVAL,
    );
}

#[test]
fn status_spinner_partial_mutates_only_status_cell() {
    let area = Rect::new(0, 0, 8, 2);
    let mut buffer = Buffer::empty(area);
    buffer.set_string(0, 0, "abcdefgh", Style::default().fg(Color::White));
    buffer.set_string(0, 1, "ABCDEFGH", Style::default().fg(Color::Blue));
    buffer
        .cell_mut((2, 1))
        .expect("status cell")
        .set_symbol("⠋");
    let before = buffer.clone();

    let status_area = Rect::new(2, 1, 6, 1);
    assert!(render_status_spinner_into_buffer(&buffer, status_area, "⠙"));
    render_status_spinner_into_buffer_mut(&mut buffer, status_area, "⠙");

    for y in 0..2 {
        for x in 0..8 {
            if (x, y) == (2, 1) {
                assert_eq!(buffer.cell((x, y)).unwrap().symbol(), "⠙");
                assert_eq!(
                    buffer.cell((x, y)).unwrap().fg,
                    arterm_tui_style::theme::ai_color()
                );
            } else {
                assert_eq!(buffer.cell((x, y)), before.cell((x, y)));
            }
        }
    }
}

#[test]
fn status_spinner_partial_does_not_overwrite_slash_palette_cell() {
    let area = Rect::new(0, 0, 12, 1);
    let mut buffer = Buffer::empty(area);
    buffer.set_string(0, 0, "/help  show help", Style::default().fg(Color::Yellow));

    assert!(
        !render_status_spinner_into_buffer(&buffer, area, "⠙"),
        "late overlays own the status cell until the next full frame"
    );
}

/// A backend that mimics crossterm when the shared event-reader mutex is
/// parked by the `EventStream` thread: every cursor-position query fails
/// after the lock timeout. Everything else delegates to `TestBackend`.
struct CursorQueryRefusingBackend {
    inner: ratatui::backend::TestBackend,
    cursor_queries: u32,
}

impl CursorQueryRefusingBackend {
    fn new(width: u16, height: u16) -> Self {
        Self {
            inner: ratatui::backend::TestBackend::new(width, height),
            cursor_queries: 0,
        }
    }
}

impl ratatui::backend::Backend for CursorQueryRefusingBackend {
    type Error = std::io::Error;

    fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
    where
        I: Iterator<Item = (u16, u16, &'a ratatui::buffer::Cell)>,
    {
        self.inner.draw(content).map_err(infallible_to_io)
    }

    fn hide_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.hide_cursor().map_err(infallible_to_io)
    }

    fn show_cursor(&mut self) -> Result<(), Self::Error> {
        self.inner.show_cursor().map_err(infallible_to_io)
    }

    fn get_cursor_position(&mut self) -> Result<ratatui::layout::Position, Self::Error> {
        self.cursor_queries += 1;
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "The cursor position could not be read within a normal duration",
        ))
    }

    fn set_cursor_position<P: Into<ratatui::layout::Position>>(
        &mut self,
        position: P,
    ) -> Result<(), Self::Error> {
        self.inner
            .set_cursor_position(position)
            .map_err(infallible_to_io)
    }

    fn clear(&mut self) -> Result<(), Self::Error> {
        self.inner.clear().map_err(infallible_to_io)
    }

    fn clear_region(&mut self, clear_type: ClearType) -> Result<(), Self::Error> {
        self.inner
            .clear_region(clear_type)
            .map_err(infallible_to_io)
    }

    fn size(&self) -> Result<ratatui::layout::Size, Self::Error> {
        self.inner.size().map_err(infallible_to_io)
    }

    fn window_size(&mut self) -> Result<ratatui::backend::WindowSize, Self::Error> {
        self.inner.window_size().map_err(infallible_to_io)
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        self.inner.flush().map_err(infallible_to_io)
    }
}

fn infallible_to_io(error: core::convert::Infallible) -> std::io::Error {
    match error {}
}

/// Regression for the startup/resume crash "Error: The cursor position could
/// not be read within a normal duration": ratatui's `Terminal::clear()`
/// queries the cursor position first, and under crossterm that query dies
/// whenever the `EventStream` reader thread parks on the shared event-reader
/// mutex. The hard-clear path must clear via `clear_region(All)` (the same
/// ED2 escape, no cursor round-trip) and still force the next draw to
/// re-emit every cell.
#[test]
fn hard_clear_survives_a_backend_that_refuses_cursor_queries() {
    use super::hard_clear_without_cursor_query;

    let render = |f: &mut ratatui::Frame| {
        let area = f.area();
        for y in 0..area.height {
            f.render_widget(
                ratatui::widgets::Paragraph::new(format!("frame line {y:02}")),
                ratatui::layout::Rect::new(0, y, area.width, 1),
            );
        }
    };

    let backend = CursorQueryRefusingBackend::new(40, 8);
    let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
    terminal.draw(render).expect("initial draw");
    let painted = terminal.backend().inner.buffer().clone();

    hard_clear_without_cursor_query(&mut terminal).expect("hard clear must not query the cursor");
    assert_eq!(
        terminal.backend().cursor_queries,
        0,
        "the cursor-safe hard clear must never issue a cursor-position query"
    );

    // The screen was wiped by ED2, so the next draw must re-emit every cell,
    // not just the ones that differ from the previous frame.
    terminal.draw(render).expect("repaint after hard clear");
    assert_eq!(
        terminal.backend().inner.buffer(),
        &painted,
        "after a hard clear the next draw must fully repaint the screen"
    );

    // The old code path really is fatal against this backend: this pins why
    // the helper exists rather than calling `Terminal::clear()`.
    let err = terminal
        .clear()
        .expect_err("Terminal::clear must fail when the cursor query is refused");
    assert!(
        err.to_string()
            .contains("cursor position could not be read"),
        "unexpected error: {err}"
    );
}
