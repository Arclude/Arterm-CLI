use super::*;
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use unicode_width::UnicodeWidthStr;

fn inline_view_display_width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

pub(super) fn inline_ui_height(app: &dyn TuiState, width: u16) -> u16 {
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
            // Wrapped rows: mirror draw_ask_user's layout math so the reserved
            // height matches what actually renders (no cut-off labels).
            let wrap_width = (width.saturating_sub(2)).max(8) as usize;
            let mut rows = 0usize;
            rows += wrap_plain(&ask.question, wrap_width).len().max(1);
            for option in &ask.options {
                rows += wrap_plain(&option.label, wrap_width.saturating_sub(5)).len();
                if let Some(detail) = option.detail.as_deref() {
                    rows += wrap_plain(detail, wrap_width.saturating_sub(5)).len();
                }
            }
            rows += 2; // custom-answer hint + key hint
            rows += 2; // box borders
            rows.min(14) as u16
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

    // Wrap width: box borders (2) + the "▸ N. " option prefix reserve.
    let wrap_width = width.saturating_sub(2).max(8);
    let option_prefix = "▸ 9. ".len(); // widest prefix, kept on wrap indents

    let mut lines: Vec<Line> = Vec::new();
    for (i, chunk) in wrap_plain(&ask.question, wrap_width).into_iter().enumerate() {
        let style = Style::default()
            .fg(question_color)
            .add_modifier(Modifier::BOLD);
        lines.push(Line::from(Span::styled(
            if i == 0 { chunk } else { format!("  {chunk}") },
            style,
        )));
    }
    for (index, option) in ask.options.iter().enumerate() {
        let number = index + 1;
        let is_selected = index == ask.selected;
        let marker = if is_selected { "▸" } else { " " };
        let style = if is_selected {
            highlight
        } else {
            Style::default().fg(option_color)
        };
        let head = format!("{marker} {number}. ");
        // Wrap the label, carrying the visual indent on continuation lines so
        // a long label reads as one option instead of spilling into the next.
        let label_wrapped = wrap_plain(&option.label, wrap_width.saturating_sub(head.width()));
        for (i, chunk) in label_wrapped.into_iter().enumerate() {
            if i == 0 {
                lines.push(Line::from(Span::styled(format!("{head}{chunk}"), style)));
            } else {
                lines.push(Line::from(Span::styled(
                    format!("{}{chunk}", " ".repeat(head.width())),
                    style,
                )));
            }
        }
        if let Some(detail) = option.detail.as_deref() {
            let indent = " ".repeat(option_prefix);
            for chunk in wrap_plain(detail, wrap_width.saturating_sub(option_prefix)) {
                lines.push(Line::from(Span::styled(
                    format!("{indent}{chunk}"),
                    Style::default().fg(dim),
                )));
            }
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

    // Clamp to the available rows. Prioritize: question, every option label,
    // the hint, then details last (details are the only optional rows).
    let max_rows = height.saturating_sub(2);
    if lines.len() > max_rows {
        // Drop detail continuation/hint rows from the bottom until it fits,
        // then hard-truncate whatever remains.
        let hint = lines.pop();
        while lines.len() > max_rows.saturating_sub(1) && lines.len() > 1 {
            lines.pop();
        }
        if let Some(hint) = hint {
            lines.push(hint);
        }
        lines.truncate(max_rows);
        // Signal that content was elided so the user knows more exists.
        if lines.len() == max_rows {
            if let Some(last) = lines.last_mut() {
                *last = Line::from(Span::styled(
                    "… (daha fazlası için terminali büyüt)",
                    Style::default().fg(hint_color),
                ));
            }
        }
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

/// Word-wrap a plain (unstyled) string to `width` display columns.
/// Long unbroken tokens are hard-split at the width. Never panics on
/// multi-byte text: slicing happens on char boundaries.
fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut out: Vec<String> = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            out.push(String::new());
            continue;
        }
        let mut current = String::new();
        let mut current_width = 0usize;
        for word in raw_line.split_whitespace() {
            let word_width = UnicodeWidthStr::width(word);
            let sep = if current.is_empty() { 0 } else { 1 };
            if current_width + sep + word_width <= width {
                if sep == 1 {
                    current.push(' ');
                    current_width += 1;
                }
                current.push_str(word);
                current_width += word_width;
            } else if word_width <= width {
                out.push(std::mem::take(&mut current));
                current.push_str(word);
                current_width = word_width;
            } else {
                // Hard-split the oversized token across lines.
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
                let mut chunk = String::new();
                let mut chunk_width = 0usize;
                for ch in word.chars() {
                    let ch_width = UnicodeWidthStr::width(ch.to_string().as_str());
                    if chunk_width + ch_width > width {
                        out.push(std::mem::take(&mut chunk));
                        chunk_width = 0;
                    }
                    chunk.push(ch);
                    chunk_width += ch_width;
                }
                current = chunk;
                current_width = chunk_width;
            }
        }
        out.push(current);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
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

/// Test-only exposure of the plain-text wrapper used by the ask_user box.
#[cfg(test)]
pub(in crate::tui) fn wrap_plain_for_test(text: &str, width: usize) -> Vec<String> {
    wrap_plain(text, width)
}
