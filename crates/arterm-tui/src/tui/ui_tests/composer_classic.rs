//! The classic look frames the composer; the arterm look leaves it bare.
//!
//! These drive the real `draw_input`, because the thing worth testing is not
//! that the rails can be built -- `composer_frame`'s own tests cover that -- but
//! that the look actually reaches the screen and that the body still lands
//! inside the frame instead of on top of it.

use super::*;
use ratatui::backend::TestBackend;
use ratatui::{Terminal, layout::Rect};

/// Set `[display] look`, render the composer, and restore the config.
///
/// Writing the config makes these tests share state with everything else that
/// does, so they take the same process-wide lock `/colors`'s tests take.
fn rows_for_look(look: &str, input: &str, width: u16, height: u16) -> Vec<String> {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            let mut config = crate::config::Config::load();
            config.display.look = String::new();
            let _ = config.save();
        }
    }

    let _lock = crate::storage::lock_test_env();
    let _restore = Restore;
    {
        let mut config = crate::config::Config::load();
        config.display.look = look.to_string();
        let _ = config.save();
    }

    let state = TestState {
        input: input.to_string(),
        cursor_pos: input.len(),
        ..Default::default()
    };

    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("failed to create test terminal");
    terminal
        .draw(|frame| {
            let area = Rect::new(0, 0, width, height);
            crate::tui::ui::input_ui::draw_input(frame, &state, area, 1, &mut None);
        })
        .expect("failed to draw the composer");

    let buf = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buf[(x, y)].symbol().to_string())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}

/// The whole point of the stage: `/theme classic` has to change the screen, not
/// just the config file.
#[test]
fn the_classic_look_draws_rails_around_the_composer() {
    let rows = rows_for_look("classic", "refactor auth.rs", 60, 5);

    let top = rows.first().expect("a top row");
    assert!(top.starts_with("╭─"), "top rail missing: {top:?}");
    assert!(top.contains("ARTERM"), "the rail should name us: {top:?}");
    assert!(top.ends_with("─╮"), "top rail unclosed: {top:?}");

    let bottom = rows.last().expect("a bottom row");
    assert!(bottom.starts_with("╰─"), "bottom rail missing: {bottom:?}");
    assert!(
        bottom.contains("Enter send"),
        "the hint rides the bottom rail: {bottom:?}"
    );
    assert!(bottom.ends_with("─╯"), "bottom rail unclosed: {bottom:?}");
}

/// A frame that overlaps what it frames is worse than no frame.
#[test]
fn the_typed_text_lands_inside_the_frame() {
    let rows = rows_for_look("classic", "refactor auth.rs", 60, 5);
    let typed = rows
        .iter()
        .find(|row| row.contains("refactor auth.rs"))
        .expect("the typed text should be on screen");
    assert!(
        typed.starts_with('│'),
        "the body row should open with a bar: {typed:?}"
    );
    assert!(
        !typed.starts_with("╭") && !typed.starts_with("╰"),
        "the text must not land on a rail: {typed:?}"
    );
}

#[test]
fn the_built_in_look_is_left_exactly_as_it_was() {
    let rows = rows_for_look("", "refactor auth.rs", 60, 5);
    assert!(
        rows.iter()
            .all(|row| !row.contains('╭') && !row.contains('╰')),
        "the arterm look must draw no frame: {rows:?}"
    );
    assert!(
        rows.iter().any(|row| row.contains("refactor auth.rs")),
        "the composer should still render: {rows:?}"
    );
}

/// Below the minimum the rails would leave nothing to frame, and half a frame
/// reads as a rendering bug rather than a theme.
#[test]
fn a_window_too_small_for_a_frame_falls_back_instead_of_drawing_half_of_one() {
    let rows = rows_for_look("classic", "hi", 12, 5);
    assert!(
        rows.iter().all(|row| !row.contains('╭')),
        "no frame below the minimum width: {rows:?}"
    );
    let rows = rows_for_look("classic", "hi", 60, 2);
    assert!(
        rows.iter().all(|row| !row.contains('╭')),
        "no frame below the minimum height: {rows:?}"
    );
}
