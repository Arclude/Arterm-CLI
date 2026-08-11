//! Bottom status bar — permission mode badge, key hints, scroll indicator.

use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

/// Render the single-line bottom status bar.
///
/// - **Left**: permission mode badge — `ASK` (yellow), `AUTO` (cyan),
///   `YOLO` (red bold). Unknown modes are shown uppercased in gray.
/// - **Center**: key hints in dim gray.
/// - **Right**: `↑ {n} lines up` when `scroll_offset > 0`.
pub fn render_status_bar(
    frame: &mut Frame,
    area: Rect,
    key_hints: &str,
    mode: &str,
    scroll_offset: usize,
) {
    // ── Left: mode badge ─────────────────────────────────────────────
    let badge = mode.to_uppercase();
    let (color, bold) = match badge.as_str() {
        "ASK" => (Color::Yellow, false),
        "AUTO" => (Color::Cyan, false),
        "YOLO" => (Color::Red, true),
        _ => (Color::Gray, false),
    };
    let mut style = Style::default().fg(color);
    if bold {
        style = style.add_modifier(Modifier::BOLD);
    }
    let left = Line::from(vec![Span::styled(format!(" {badge} "), style)]);

    // ── Center: dim key hints ────────────────────────────────────────
    let center = Line::from(vec![Span::styled(
        key_hints.to_string(),
        Style::default().fg(Color::DarkGray),
    )]);

    frame.render_widget(Paragraph::new(left), area);
    frame.render_widget(
        Paragraph::new(center).alignment(Alignment::Center),
        area,
    );

    // ── Right: scroll indicator ──────────────────────────────────────
    if scroll_offset > 0 {
        let right = Line::from(vec![Span::styled(
            format!("↑ {scroll_offset} lines up "),
            Style::default().fg(Color::Blue),
        )]);
        frame.render_widget(
            Paragraph::new(right).alignment(Alignment::Right),
            area,
        );
    }
}
