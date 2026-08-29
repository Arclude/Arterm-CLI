use super::*;
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use unicode_width::UnicodeWidthStr;

fn inline_view_display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub(super) fn inline_ui_height(app: &dyn TuiState) -> u16 {
    match app.inline_ui_state() {
        Some(crate::tui::InlineUiStateRef::Interactive(picker)) => {
            let visible_rows = picker.filtered.len() as u16;
            let rows_needed = visible_rows + 1 + 2; // header + rounded border
            // Reserve one extra row for the model-picker hotkey hint that is
            // rendered ABOVE the box (outside its border). Shown for runtime model
            // pickers in both focused and preview modes.
            let hint_rows: u16 = if picker.kind == crate::tui::PickerKind::Model
                && picker
                    .entries
                    .iter()
                    .any(|entry| matches!(entry.action, crate::tui::PickerAction::Model))
            {
                1
            } else {
                0
            };
            rows_needed.min(20) + hint_rows
        }
        Some(crate::tui::InlineUiStateRef::View(view)) => {
            let visible_rows = view.lines.len().max(1) as u16;
            let rows_needed = visible_rows + 1 + 2; // header + rounded border
            rows_needed.min(10)
        }
        Some(crate::tui::InlineUiStateRef::AskUser(ask)) => {
            // question row + option rows (+ detail lines) + hint row + border
            let mut rows = 1u16;
            for option in &ask.options {
                rows += 1;
                if option.detail.is_some() {
                    rows += 1;
                }
            }
            if ask.allow_custom {
                rows += 1;
            }
            rows += 2; // "1-9/↑↓ choose · Enter submit" hint
            rows + 2
        }
        None => 0,
    }
}

pub(super) fn draw_inline_ui(frame: &mut Frame, app: &dyn TuiState, area: Rect) {
    match app.inline_ui_state() {
        Some(crate::tui::InlineUiStateRef::Interactive(_)) => {
            super::inline_interactive_ui::draw_inline_interactive(frame, app, area)
        }
        Some(crate::tui::InlineUiStateRef::View(view)) => draw_inline_view(frame, app, view, area),
        Some(crate::tui::InlineUiStateRef::AskUser(ask)) => draw_ask_user(frame, app, ask, area),
        None => {}
    }
}

/// Claude Code-style numbered option list for a pending ask_user question.
fn draw_ask_user(
    frame: &mut Frame,
    app: &dyn TuiState,
    ask: &crate::tui::PendingAskUser,
    area: Rect,
) {
    use ratatui::style::{Modifier, Style};
    use ratatui::text::{Line, Span};

    let height = area.height as usize;
    let width = area.width as usize;
    if height <= 2 || width <= 4 {
        return;
    }

    let question_color = rgb(200, 220, 255);
    let option_color = rgb(170, 190, 170);
    let dim = rgb(120, 120, 130);
    let highlight = Style::default()
        .fg(rgb(140, 180, 255))
        .add_modifier(Modifier::BOLD);
    let hint_color = rgb(110, 130, 150);

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(Span::styled(
        ask.question.clone(),
        Style::default().fg(question_color).add_modifier(Modifier::BOLD),
    )));
    for (index, option) in ask.options.iter().enumerate() {
        let number = index + 1;
        let is_selected = index == ask.selected;
        let marker = if is_selected { "▸" } else { " " };
        let label_span = if is_selected {
            Span::styled(format!("{marker} {number}. {}", option.label), highlight)
        } else {
            Span::styled(
                format!("{marker} {number}. {}", option.label),
                Style::default().fg(option_color),
            )
        };
        lines.push(Line::from(label_span));
        if let Some(detail) = option.detail.as_deref() {
            lines.push(Line::from(Span::styled(
                format!("     {detail}"),
                Style::default().fg(dim),
            )));
        }
    }
    if ask.allow_custom {
        lines.push(Line::from(Span::styled(
            "or type your own answer + Enter",
            Style::default().fg(hint_color),
        )));
    }
    lines.push(Line::from(Span::styled(
        "1-9/↑↓ choose · Enter submit",
        Style::default().fg(hint_color),
    )));

    // Clamp to the available rows, keeping the question row visible.
    let max_rows = height.saturating_sub(2);
    if lines.len() > max_rows {
        lines.truncate(max_rows);
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(Span::styled(" ? ", Style::default().fg(question_color)));
    let paragraph = if app.centered_mode() {
        Paragraph::new(
            lines
                .iter()
                .map(|l| l.clone().alignment(ratatui::layout::Alignment::Center))
                .collect::<Vec<_>>(),
        )
        .block(block)
    } else {
        Paragraph::new(lines).block(block)
    };
    frame.render_widget(paragraph, area);
}

fn draw_inline_view(
    frame: &mut Frame,
    app: &dyn TuiState,
    view: &crate::tui::InlineViewState,
    area: Rect,
) {
    let height = area.height as usize;
    let width = area.width as usize;
    if height <= 2 || width <= 2 {
        return;
    }

    let mut content_width = inline_view_display_width(view.title.as_str());
    if let Some(status) = view.status.as_ref() {
        content_width = content_width.max(inline_view_display_width(status.as_str()) + 2);
    }
    for line in &view.lines {
        content_width = content_width.max(inline_view_display_width(line.as_str()));
    }
    let content_width = content_width.min(width.saturating_sub(2)).max(1);
    let outer_width = content_width.saturating_add(2).min(width);
    let horizontal_offset = if app.centered_mode() {
        area.width.saturating_sub(outer_width as u16) / 2
    } else {
        0
    };
    let render_area = Rect {
        x: area.x + horizontal_offset,
        y: area.y,
        width: outer_width as u16,
        height: area.height,
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(rgb(85, 85, 110)))
        .style(Style::default().bg(rgb(18, 18, 26)));
    frame.render_widget(block.clone(), render_area);

    let inner = block.inner(render_area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    let mut lines: Vec<Line> = Vec::new();
    let mut header_spans = vec![Span::styled(
        view.title.clone(),
        Style::default().fg(Color::White).bold(),
    )];
    if let Some(status) = view.status.as_ref() {
        header_spans.push(Span::styled(
            format!("  {}", status),
            Style::default().fg(dim_color()).italic(),
        ));
    }
    lines.push(Line::from(header_spans));

    for line in &view.lines {
        lines.push(Line::from(Span::styled(
            line.clone(),
            Style::default().fg(rgb(200, 200, 220)),
        )));
    }

    frame.render_widget(Paragraph::new(lines), inner);
}
