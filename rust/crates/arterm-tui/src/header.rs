//! Top header bar — bold title, provider/model, and live status indicator.
//!
//! Rendered as a single line at the top of the TUI. The thin separator
//! below is drawn by the transcript block's top border (see
//! [`crate::App::draw`]).

use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

/// Render the single-line header bar.
///
/// - **Left**: `Arterm v{version}` in bold cyan.
/// - **Center**: `| {provider}/{model} |` in gray.
/// - **Right**: status indicator — `● idle` (green), `● thinking`
///   (yellow), or `● error` (red).
pub fn render_header(
    frame: &mut Frame,
    area: Rect,
    provider: &str,
    model: &str,
    version: &str,
    status: &str,
) {
    // ── Left: bold cyan title ────────────────────────────────────────
    let left = Line::from(vec![Span::styled(
        format!(" Arterm v{version} "),
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )]);

    // ── Center: gray provider/model ──────────────────────────────────
    let center = Line::from(vec![Span::styled(
        format!("| {provider}/{model} |"),
        Style::default().fg(Color::Gray),
    )]);

    // ── Right: status indicator ──────────────────────────────────────
    let (dot_color, label) = match status.to_ascii_lowercase().as_str() {
        "thinking" | "busy" | "working" => (Color::Yellow, "thinking"),
        "error" => (Color::Red, "error"),
        _ => (Color::Green, "idle"),
    };
    let right = Line::from(vec![
        Span::styled(
            "●",
            Style::default()
                .fg(dot_color)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(format!("{label} "), Style::default().fg(dot_color)),
    ]);

    frame.render_widget(Paragraph::new(left), area);
    frame.render_widget(
        Paragraph::new(center).alignment(Alignment::Center),
        area,
    );
    frame.render_widget(
        Paragraph::new(right).alignment(Alignment::Right),
        area,
    );
}
