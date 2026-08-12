//! In centered mode the caret must sit on the cell after the text — every
//! width, every length.
//!
//! `Paragraph` centers a line at `(area_width / 2) - (line_width / 2)`. Any
//! companion arithmetic that computes where that line landed has to use the
//! same expression: `(area_width - line_width) / 2` looks equivalent and is off
//! by one whenever the two widths differ in parity. The visible symptom was a
//! cursor that sat on the last character instead of after it, alternating with
//! every keystroke, and mouse clicks that selected the neighbouring character.
//!
//! These tests sweep both parities rather than pinning one case, because a
//! single width would have passed against the broken formula.

use super::*;
use ratatui::backend::TestBackend;
use ratatui::{Terminal, layout::Rect};

/// Render the composer and report (caret column, column of the last painted
/// text cell) on the input row.
fn caret_and_text_end(input: &str, width: u16) -> (u16, u16) {
    let state = TestState {
        input: input.to_string(),
        cursor_pos: input.len(),
        centered_mode: true,
        ..Default::default()
    };

    let backend = TestBackend::new(width, 6);
    let mut terminal = Terminal::new(backend).expect("failed to create test terminal");
    let mut caret = None;
    terminal
        .draw(|frame| {
            let area = Rect::new(0, 0, width, 6);
            caret = crate::tui::ui::input_ui::draw_input(frame, &state, area, 1, &mut None);
        })
        .expect("failed to draw the composer");

    let caret = caret.expect("the composer should place a caret");
    let buf = terminal.backend().buffer();
    let last_text_x = (0..width)
        .rev()
        .find(|x| buf[(*x, caret.y)].symbol().trim() != "")
        .expect("the composer row should have painted something");
    (caret.x, last_text_x)
}

#[test]
fn the_caret_follows_the_text_at_every_width() {
    // Sweep widths and lengths so both parities of (area width, line width) are
    // covered; the broken formula passed for half of these.
    for width in [80u16, 81, 100, 101, 120, 121] {
        for input in ["a", "ab", "abc", "abcd", "diagrramalar", "diagrramalar!"] {
            let (caret_x, last_text_x) = caret_and_text_end(input, width);
            assert_eq!(
                caret_x,
                last_text_x + 1,
                "caret should sit just after the text (width={width}, input={input:?})"
            );
        }
    }
}

#[test]
fn a_left_aligned_composer_is_unaffected() {
    let input = "diagrramalar";
    let state = TestState {
        input: input.to_string(),
        cursor_pos: input.len(),
        centered_mode: false,
        ..Default::default()
    };

    let width = 100;
    let backend = TestBackend::new(width, 6);
    let mut terminal = Terminal::new(backend).expect("failed to create test terminal");
    let mut caret = None;
    terminal
        .draw(|frame| {
            let area = Rect::new(0, 0, width, 6);
            caret = crate::tui::ui::input_ui::draw_input(frame, &state, area, 1, &mut None);
        })
        .expect("failed to draw the composer");

    let caret = caret.expect("the composer should place a caret");
    let buf = terminal.backend().buffer();
    let last_text_x = (0..width)
        .rev()
        .find(|x| buf[(*x, caret.y)].symbol().trim() != "")
        .expect("the composer row should have painted something");
    assert_eq!(caret.x, last_text_x + 1);
}
