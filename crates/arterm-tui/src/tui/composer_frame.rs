//! The `classic` composer's frame, drawn as text rather than as a border.
//!
//! ```text
//! ╭─ ◆ ARTERM ─────────────────── ⠹ working 12.4s ─╮
//! │ › refactor auth.rs to async                    │
//! ╰─ Enter send · ? help · Esc cancels ────────────╯
//! ```
//!
//! Ported from `packages/tui/src/Composer.tsx` at `ab57e7f^`, whose reasoning
//! carries over intact: a border is a single color and holds no text, so the two
//! things worth putting on the frame -- which program is asking, and whether it
//! is working right now -- had nowhere to go. A rail is a string, so it carries
//! the spinner on the right and the hint along the bottom without spending two
//! more rows of a small terminal on them.
//!
//! Both variable widths are *reserved* rather than measured after the fact,
//! because both change while the frame is on screen: the status slot holds a
//! spinner and a clock that counts `9.9s → 10s → 1m05s`, and the bottom hint
//! changes with the mode. Laid out left to right and closed at the end, the
//! corner would move every second.
//!
//! Nothing here measures with `len()`. A two-column glyph pasted into the prompt
//! would push the closing corner past the edge, which wraps the row, which
//! pushes a transcript line into the scrollback on every repaint.

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthStr;

/// Rows the two rails cost the composer's layout slot.
pub const RAIL_ROWS: u16 = 2;

/// Below this the frame is not drawn at all: the rails would leave no room for
/// what they are framing, and half a frame reads as a rendering bug.
pub const MIN_WIDTH: u16 = 16;
pub const MIN_HEIGHT: u16 = 3;

/// The brand shown on the top rail, matching the TypeScript `glyphs.brand`.
pub const TITLE: &str = "◆ ARTERM";

/// What the bottom rail says when the composer has nothing more urgent.
pub const DEFAULT_HINT: &str = "Enter send · ? help · Esc cancels";

/// Columns a rail keeps for its own text before it will admit an optional slot
/// (the working clock, the scroll note) beside it.
const MIN_TITLE_WIDTH: usize = 6;
const MIN_HINT_WIDTH: usize = 6;

/// Whether `area` can hold the frame.
pub fn fits(area: Rect) -> bool {
    area.width >= MIN_WIDTH && area.height >= MIN_HEIGHT
}

/// Rows the composer's layout slot needs.
///
/// The frame costs two rows and gives one back: the hint the bare look prints on
/// a row of its own rides the bottom rail instead. Reserving anything less here
/// than what is drawn would paint a rail over the transcript's last line, once
/// per repaint.
pub fn layout_rows(body_rows: u16, hint_rows: u16, classic: bool) -> u16 {
    if classic {
        body_rows.saturating_add(RAIL_ROWS)
    } else {
        body_rows.saturating_add(hint_rows)
    }
}

/// The content area between the rails: one row in from each rail, and one
/// column of padding inside each vertical bar.
pub fn inner_area(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(2),
        y: area.y.saturating_add(1),
        width: area.width.saturating_sub(4),
        height: area.height.saturating_sub(RAIL_ROWS),
    }
}

/// Paint the rails into `area` and return the area left for the composer body.
///
/// The vertical bars come from a rounded block and both rails are then
/// overwritten with their own text. Drawing the sides any other way would mean
/// painting a bar per body row from out here, which is the body's business.
pub fn draw(
    frame: &mut ratatui::Frame,
    area: Rect,
    status: Option<&str>,
    hint: &str,
    status_color: Color,
) -> Rect {
    use ratatui::widgets::{Block, BorderType, Borders, Paragraph};

    let rail_color = arterm_tui_style::theme::border_color();
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(rail_color)),
        area,
    );

    frame.render_widget(
        Paragraph::new(top_rail(
            area.width,
            TITLE,
            status.map(|text| (text, status_color)),
            rail_color,
        )),
        Rect { height: 1, ..area },
    );
    frame.render_widget(
        Paragraph::new(bottom_rail(
            area.width,
            hint,
            None,
            rail_color,
            arterm_tui_style::theme::dim_color(),
        )),
        Rect {
            y: area.y + area.height - 1,
            height: 1,
            ..area
        },
    );

    inner_area(area)
}

/// `╭─ ◆ ARTERM ──────── <status> ─╮`, exactly `width` columns wide.
///
/// `status` is drawn in its own style and reserved out of the fill, so the
/// closing corner does not move as the clock ticks.
pub fn top_rail(
    width: u16,
    title: &str,
    status: Option<(&str, Color)>,
    color: Color,
) -> Line<'static> {
    let rail = Style::default().fg(color);
    let width = width as usize;
    // Lead and close are fixed; everything else competes for what is left.
    let available = width.saturating_sub(4);

    // The status is dropped rather than truncated when it will not fit beside a
    // readable title: half a clock says less than no clock, and a rail that
    // overruns its width wraps the row.
    let status_text = match status {
        Some((text, _)) => fit_slot(text, available, MIN_TITLE_WIDTH),
        None => String::new(),
    };

    let title_text = truncate_to_width(
        &format!(" {title} "),
        available.saturating_sub(status_text.width()),
    );
    let fill = available
        .saturating_sub(status_text.width())
        .saturating_sub(title_text.width());

    let mut spans = vec![
        Span::styled("╭─", rail),
        Span::styled(title_text, rail.add_modifier(Modifier::BOLD)),
        Span::styled("─".repeat(fill), rail),
    ];
    if let Some((_, status_color)) = status
        && !status_text.is_empty()
    {
        spans.push(Span::styled(status_text, Style::default().fg(status_color)));
    }
    spans.push(Span::styled("─╮", rail));
    Line::from(spans)
}

/// `╰─ <hint> ─── <scroll note> ─╯`, exactly `width` columns wide.
///
/// The scroll note goes *inside* the rail rather than after its closing corner:
/// the row is exactly `width` wide and truncated there, so anything written past
/// the corner is written into nothing.
pub fn bottom_rail(
    width: u16,
    hint: &str,
    scroll_note: Option<&str>,
    color: Color,
    hint_color: Color,
) -> Line<'static> {
    let rail = Style::default().fg(color);
    let width = width as usize;
    let available = width.saturating_sub(4);

    // Same rule as the status slot: a note that leaves no room for the hint is
    // dropped whole rather than allowed to push the corner off the row.
    let note_text = match scroll_note {
        Some(note) => fit_slot(note, available, MIN_HINT_WIDTH),
        None => String::new(),
    };

    let hint_text = truncate_to_width(
        &format!(" {hint} "),
        available.saturating_sub(note_text.width()),
    );
    let fill = available
        .saturating_sub(note_text.width())
        .saturating_sub(hint_text.width());

    let mut spans = vec![
        Span::styled("╰─", rail),
        Span::styled(hint_text, Style::default().fg(hint_color)),
    ];
    if !note_text.is_empty() {
        spans.push(Span::styled(note_text, Style::default().fg(hint_color)));
    }
    spans.push(Span::styled("─".repeat(fill), rail));
    spans.push(Span::styled("─╯", rail));
    Line::from(spans)
}

/// An optional slot's text, padded with a space each side -- or nothing at all
/// when taking it would leave the rail's own text less than `keep` columns.
///
/// Dropped whole rather than truncated: half a clock says less than no clock,
/// and a rail that overruns its width wraps the row.
fn fit_slot(text: &str, available: usize, keep: usize) -> String {
    let padded = format!(" {text} ");
    if padded.width() + keep <= available {
        padded
    } else {
        String::new()
    }
}

/// `text` cut to `max` display columns, ending in `…` when anything was cut.
///
/// By column, not by `char`: a CJK title or a pasted emoji is two columns wide
/// and a count of chars would leave the rail one short and the corner adrift.
fn truncate_to_width(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let w = ch.to_string().width();
        if used + w > max.saturating_sub(1) {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

/// Columns the clock is padded to.
///
/// A clock counting `9.9s → 10s → 1m05s` changes width three times, and
/// anything laid out to its right -- the closing corner, most of all -- would
/// move with it.
pub const ELAPSED_WIDTH: usize = 6;

/// `9.9s`, `12s`, `1m05s` -- `fmtElapsed` from the TypeScript composer.
///
/// One decimal only under ten seconds: a tenth is legible while you are waiting
/// for the first token and meaningless once you have stopped watching.
pub fn format_elapsed(secs: f32) -> String {
    if secs < 0.0 {
        return "0.0s".to_string();
    }
    if secs < 10.0 {
        return format!("{secs:.1}s");
    }
    if secs < 60.0 {
        return format!("{}s", secs.floor() as u64);
    }
    let minutes = (secs / 60.0).floor() as u64;
    let seconds = (secs % 60.0).floor() as u64;
    format!("{minutes}m{seconds:02}s")
}

/// `⠹ working 12.4s` -- the top rail's right-hand slot while a turn runs.
pub fn status_label(spinner: &str, elapsed_secs: f32) -> String {
    format!(
        "{spinner} working {:<width$}",
        format_elapsed(elapsed_secs),
        width = ELAPSED_WIDTH
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(line: &Line<'_>) -> String {
        line.spans.iter().map(|s| s.content.as_ref()).collect()
    }

    /// The row is exactly the terminal's width. One column over and it wraps,
    /// which scrolls a transcript row away on every repaint.
    #[test]
    fn both_rails_are_exactly_the_width_they_are_given() {
        for width in [16u16, 17, 40, 41, 80, 120, 200] {
            let top = top_rail(width, TITLE, None, Color::Reset);
            assert_eq!(top.width(), width as usize, "top rail at {width}");

            let working = top_rail(
                width,
                TITLE,
                Some(("⠹ working 12.4s", Color::Reset)),
                Color::Reset,
            );
            assert_eq!(
                working.width(),
                width as usize,
                "working top rail at {width}"
            );

            let bottom = bottom_rail(width, DEFAULT_HINT, None, Color::Reset, Color::Reset);
            assert_eq!(bottom.width(), width as usize, "bottom rail at {width}");

            let scrolled = bottom_rail(
                width,
                DEFAULT_HINT,
                Some("↑3 more"),
                Color::Reset,
                Color::Reset,
            );
            assert_eq!(scrolled.width(), width as usize, "scrolled rail at {width}");
        }
    }

    /// A double-width glyph is the case `len()` gets wrong, and the one a user
    /// produces by pasting.
    #[test]
    fn a_double_width_title_still_closes_the_rail() {
        for width in [20u16, 21, 60] {
            let line = top_rail(width, "◆ 日本語のタイトル", None, Color::Reset);
            assert_eq!(line.width(), width as usize, "at {width}");
        }
    }

    /// The corner must not move while the clock ticks, so the slot is reserved
    /// at a fixed width rather than measured after the fill is laid down.
    #[test]
    fn the_closing_corner_holds_still_as_the_clock_grows() {
        let width = 60;
        let widths: Vec<usize> = ["9.9s", "10s", "1m05s", "12m30s"]
            .iter()
            .map(|clock| {
                top_rail(
                    width,
                    TITLE,
                    Some((&format!("⠹ working {clock}"), Color::Reset)),
                    Color::Reset,
                )
                .width()
            })
            .collect();
        assert!(
            widths.iter().all(|w| *w == width as usize),
            "every clock width must close the rail: {widths:?}"
        );
    }

    #[test]
    fn the_title_survives_at_a_usable_width_and_is_cut_rather_than_dropped() {
        let line = top_rail(MIN_WIDTH, TITLE, None, Color::Reset);
        assert_eq!(line.width(), MIN_WIDTH as usize);
        let text = text_of(&line);
        assert!(text.starts_with("╭─"), "{text}");
        assert!(text.ends_with("─╮"), "{text}");
    }

    /// Written past the closing corner is written into nothing, so the note has
    /// to be inside it.
    #[test]
    fn the_scroll_note_is_inside_the_rail() {
        let line = bottom_rail(
            60,
            DEFAULT_HINT,
            Some("↑7 more"),
            Color::Reset,
            Color::Reset,
        );
        let text = text_of(&line);
        assert!(text.contains("↑7 more"), "{text}");
        let note_at = text.find("↑7 more").expect("note present");
        let corner_at = text.rfind("─╯").expect("corner present");
        assert!(note_at < corner_at, "note must precede the corner: {text}");
    }

    /// A long hint yields to the rail rather than the rail yielding to it.
    #[test]
    fn a_hint_too_long_for_the_rail_is_truncated_not_wrapped() {
        let hint = "Enter send · Ctrl+Enter queue · ? help · Esc cancels · Shift+Tab modes";
        let line = bottom_rail(40, hint, None, Color::Reset, Color::Reset);
        assert_eq!(line.width(), 40);
        assert!(text_of(&line).contains('…'));
    }

    /// Reserve fewer rows than are drawn and a rail lands on the transcript's
    /// last line, repaint after repaint.
    #[test]
    fn the_slot_reserves_exactly_what_the_frame_draws() {
        for body in [1u16, 3, 10] {
            for hint in [0u16, 1] {
                let classic = layout_rows(body, hint, true);
                assert_eq!(
                    classic,
                    body + RAIL_ROWS,
                    "the frame costs two rows whatever the hint (body={body}, hint={hint})"
                );
                let inner = inner_area(Rect {
                    x: 0,
                    y: 0,
                    width: 60,
                    height: classic,
                });
                assert_eq!(
                    inner.height, body,
                    "the body must get back exactly what it asked for"
                );

                assert_eq!(layout_rows(body, hint, false), body + hint);
            }
        }
    }

    #[test]
    fn the_inner_area_leaves_a_column_of_padding_inside_each_bar() {
        let area = Rect {
            x: 3,
            y: 7,
            width: 40,
            height: 6,
        };
        let inner = inner_area(area);
        assert_eq!(inner.x, 5);
        assert_eq!(inner.y, 8);
        assert_eq!(inner.width, 36);
        assert_eq!(inner.height, 4);
    }

    #[test]
    fn a_frame_is_refused_where_it_would_leave_nothing_to_frame() {
        let tiny = Rect {
            x: 0,
            y: 0,
            width: MIN_WIDTH - 1,
            height: 8,
        };
        assert!(!fits(tiny));
        let short = Rect {
            x: 0,
            y: 0,
            width: 80,
            height: MIN_HEIGHT - 1,
        };
        assert!(!fits(short));
        assert!(fits(Rect {
            x: 0,
            y: 0,
            width: MIN_WIDTH,
            height: MIN_HEIGHT
        }));
    }

    /// The three shapes the clock takes, and the boundaries between them.
    #[test]
    fn the_clock_reads_the_way_the_typescript_one_did() {
        assert_eq!(format_elapsed(-1.0), "0.0s");
        assert_eq!(format_elapsed(0.0), "0.0s");
        assert_eq!(format_elapsed(9.94), "9.9s");
        assert_eq!(format_elapsed(10.0), "10s");
        assert_eq!(format_elapsed(59.9), "59s");
        assert_eq!(format_elapsed(60.0), "1m00s");
        assert_eq!(format_elapsed(65.4), "1m05s");
        assert_eq!(format_elapsed(750.0), "12m30s");
    }

    /// Padding is what keeps the corner still, so it is part of the label.
    #[test]
    fn the_status_label_is_one_width_whatever_the_clock_says() {
        let widths: Vec<usize> = [0.5f32, 9.9, 10.0, 65.0, 750.0]
            .iter()
            .map(|secs| status_label("⠹", *secs).width())
            .collect();
        assert!(
            widths.windows(2).all(|pair| pair[0] == pair[1]),
            "the label must not change width: {widths:?}"
        );
        assert!(status_label("⠹", 12.4).starts_with("⠹ working "));
    }
}
