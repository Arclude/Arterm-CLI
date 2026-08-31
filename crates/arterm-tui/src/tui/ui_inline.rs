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
            // height matches what actually renders (no cut-off labels). The
            // box scrolls when content exceeds the cap (20 rows, matching the
            // interactive picker), so every option stays reachable even on
            // tall questions in small terminals.
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
            rows.min(20) as u16
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
///
/// Every option is always reachable regardless of terminal size: when the
/// wrapped rows exceed the box height the list scrolls to keep the
/// highlighted option visible (arrows/digits move the highlight; the view
/// follows). A scroll indicator in the bottom border replaces the old
/// "enlarge your terminal" truncation.
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

    // Build the wrapped rows and remember where each option's rows start,
    // so the viewport can always scroll to the highlighted option.
    let mut lines: Vec<Line> = Vec::new();
    let mut tail: Vec<Line> = Vec::new();
    let mut option_row_start: Vec<usize> = Vec::with_capacity(ask.options.len());
    for (i, chunk) in wrap_plain(&ask.question, wrap_width)
        .into_iter()
        .enumerate()
    {
        let style = Style::default()
            .fg(question_color)
            .add_modifier(Modifier::BOLD);
        lines.push(Line::from(Span::styled(
            if i == 0 { chunk } else { format!("  {chunk}") },
            style,
        )));
    }
    for (index, option) in ask.options.iter().enumerate() {
        option_row_start.push(lines.len());
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
        tail.push(Line::from(Span::styled(
            "or type your own answer + Enter",
            Style::default().fg(hint_color),
        )));
    }
    tail.push(Line::from(Span::styled(
        "1-9/↑↓ choose · Enter submit",
        Style::default().fg(hint_color),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(Span::styled(" ? ", Style::default().fg(question_color)));
    let inner = block.inner(area);
    if inner.height == 0 || inner.width == 0 {
        return;
    }

    // Split the inner area: the body (question + options) scrolls, the tail
    // hints are pinned to the last rows so the controls never scroll away.
    // When rows are scarce the body wins: at least one option row is kept
    // and the tail hints shrink (or vanish) instead of hiding every option.
    let tail_height = (tail.len() as u16).min(inner.height.saturating_sub(1));
    let body_height = inner.height - tail_height;

    // Scroll the wrapped list so the highlighted option stays in view.
    let body_h = body_height as usize;
    let total_rows = lines.len();
    let scroll = if total_rows > body_h && body_h > 0 {
        // First row of the highlighted option's block.
        let sel_start = option_row_start
            .get(ask.selected)
            .copied()
            .unwrap_or(0);
        // Prefer one context row above the option block...
        let mut target = sel_start.saturating_sub(1);
        // ...but never let the option's own head row fall below the viewport.
        if sel_start + 1 > target + body_h {
            target = sel_start + 1 - body_h;
        }
        // Clamp so the last body row stays filled.
        target.min(total_rows - body_h)
    } else {
        0
    };

    // Scroll position lives on the bottom border so it never steals a row.
    let more_below = (scroll + body_height as usize) < total_rows;
    let block = if body_height > 0 && more_below {
        let indicator = if scroll > 0 {
            " ↑↓ more "
        } else {
            " ↑ more "
        };
        block.title_bottom(Span::styled(indicator, Style::default().fg(hint_color)))
    } else if scroll > 0 {
        block.title_bottom(Span::styled(" ↓ more ", Style::default().fg(hint_color)))
    } else {
        block
    };
    frame.render_widget(block, area);

    fn center_line(l: Line) -> Line {
        l.alignment(ratatui::layout::Alignment::Center)
    }
    let body_lines = if app.centered_mode() {
        lines.into_iter().map(center_line).collect::<Vec<_>>()
    } else {
        lines
    };
    let tail_len = tail.len();
    let tail_lines = if app.centered_mode() {
        tail.into_iter().map(center_line).collect::<Vec<_>>()
    } else {
        tail
    };
    let body_area = Rect {
        height: body_height,
        ..inner
    };
    frame.render_widget(
        Paragraph::new(body_lines).scroll((scroll as u16, 0)),
        body_area,
    );
    if tail_height > 0 {
        let tail_area = Rect {
            y: inner.y + body_height,
            height: tail_height,
            ..inner
        };
        // Only the last `tail_height` hint rows fit when the tail shrank.
        let visible_tail: Vec<Line> = tail_lines
            .into_iter()
            .skip(tail_len.saturating_sub(tail_height as usize))
            .collect();
        frame.render_widget(Paragraph::new(visible_tail), tail_area);
    }
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
