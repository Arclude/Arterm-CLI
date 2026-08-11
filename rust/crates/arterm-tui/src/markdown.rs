//! Lightweight markdown → ratatui [`Line`] renderer.
//!
//! Converts assistant message text into styled [`Line`] vectors suitable for
//! display in the TUI transcript.  Supports a practical subset of CommonMark:
//! headings, bold, inline code, fenced code blocks, bullet/numbered lists,
//! plain text, and blank lines.  Long lines are word-wrapped with [`textwrap`].

use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

/// Render a markdown string into a vector of ratatui [`Line`]s.
///
/// Supported elements:
///
/// | Element | Syntax | Style |
/// |---------|--------|-------|
/// | Headings | `#`, `##`, `###` | bold cyan |
/// | Bold | `**text**` | bold modifier |
/// | Inline code | `` `code` `` | yellow |
/// | Code blocks | ` ``` ` fences | dim gray, `│` prefix |
/// | Bullet lists | `- ` or `* ` | green `•` bullet |
/// | Numbered lists | `1. ` | yellow number |
/// | Regular text | — | default |
/// | Blank lines | — | empty line |
///
/// Lines longer than `width` columns are word-wrapped.
pub fn render_markdown(text: &str, width: u16) -> Vec<Line<'static>> {
    let width = (width as usize).max(1);
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut in_code_block = false;

    for raw in text.lines() {
        // ── Code-block fence ──────────────────────────────────────────
        if raw.trim_start().starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        // ── Inside a fenced code block ────────────────────────────────
        if in_code_block {
            let avail = width.saturating_sub(2).max(1);
            for w in textwrap::wrap(raw, avail) {
                lines.push(Line::from(vec![
                    Span::styled("│ ", Style::default().fg(Color::DarkGray)),
                    Span::styled(
                        w.into_owned(),
                        Style::default()
                            .fg(Color::Gray)
                            .add_modifier(Modifier::DIM),
                    ),
                ]));
            }
            continue;
        }

        // ── Blank line ────────────────────────────────────────────────
        if raw.trim().is_empty() {
            lines.push(Line::from(""));
            continue;
        }

        // ── Headings (#, ##, ###) ─────────────────────────────────────
        let heading_style = Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD);
        if let Some(rest) = raw
            .strip_prefix("### ")
            .or_else(|| raw.strip_prefix("## "))
            .or_else(|| raw.strip_prefix("# "))
        {
            for w in textwrap::wrap(rest, width) {
                lines.push(Line::from(vec![Span::styled(w.into_owned(), heading_style)]));
            }
            continue;
        }

        // ── Bullet lists (- or *) ─────────────────────────────────────
        if let Some(rest) = raw.strip_prefix("- ").or_else(|| raw.strip_prefix("* ")) {
            let avail = width.saturating_sub(2).max(1);
            for (i, w) in textwrap::wrap(rest, avail).iter().enumerate() {
                let prefix = if i == 0 {
                    Span::styled("• ", Style::default().fg(Color::Green))
                } else {
                    Span::raw("  ")
                };
                let mut spans = vec![prefix];
                spans.extend(parse_inline(w));
                lines.push(Line::from(spans));
            }
            continue;
        }

        // ── Numbered lists (1. 2. …) ──────────────────────────────────
        if let Some((num, rest)) = parse_numbered(raw) {
            let num_str = format!("{num}. ");
            let indent = " ".repeat(num_str.len());
            let avail = width.saturating_sub(num_str.len()).max(1);
            for (i, w) in textwrap::wrap(rest, avail).iter().enumerate() {
                let prefix_span = if i == 0 {
                    Span::styled(num_str.clone(), Style::default().fg(Color::Yellow))
                } else {
                    Span::raw(indent.clone())
                };
                let mut spans = vec![prefix_span];
                spans.extend(parse_inline(w));
                lines.push(Line::from(spans));
            }
            continue;
        }

        // ── Regular text ──────────────────────────────────────────────
        for w in textwrap::wrap(raw, width) {
            lines.push(Line::from(parse_inline(&w)));
        }
    }

    lines
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Try to parse a numbered-list prefix (e.g. `1. `, `42. `).
///
/// Returns `(number, remaining_text)` on success.
fn parse_numbered(line: &str) -> Option<(usize, &str)> {
    let rest = line.trim_start();
    let digits_end = rest.bytes().position(|b| !b.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let num: usize = rest[..digits_end].parse().ok()?;
    let content = rest.get(digits_end..)?.strip_prefix(". ")?;
    Some((num, content))
}

/// Parse inline markdown formatting in a single line of text.
///
/// Handles `**bold**` and `` `code` `` markers, returning styled [`Span`]s.
/// Nested patterns (e.g. `` `**bold inside code**` ``) render the inner content
/// literally for code spans; bold spans recursively parse for inline code.
fn parse_inline(text: &str) -> Vec<Span<'static>> {
    if text.is_empty() {
        return vec![Span::raw(String::new())];
    }

    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut pos = 0;

    while pos < text.len() {
        // Locate the nearest inline marker.
        let code_at = text[pos..].find('`').map(|p| pos + p);
        let bold_at = text[pos..].find("**").map(|p| pos + p);

        match nearest_marker(code_at, bold_at) {
            Some(Marker::Code(start)) => {
                match text[start + 1..].find('`') {
                    Some(end_rel) => {
                        let end = start + 1 + end_rel;
                        if start > pos {
                            spans.push(Span::raw(text[pos..start].to_string()));
                        }
                        spans.push(Span::styled(
                            text[start + 1..end].to_string(),
                            Style::default().fg(Color::Yellow),
                        ));
                        pos = end + 1;
                    }
                    None => {
                        // No closing backtick — treat rest as raw text.
                        spans.push(Span::raw(text[pos..].to_string()));
                        break;
                    }
                }
            }
            Some(Marker::Bold(start)) => match text[start + 2..].find("**") {
                Some(end_rel) => {
                    let end = start + 2 + end_rel;
                    if start > pos {
                        spans.push(Span::raw(text[pos..start].to_string()));
                    }
                    // Recursively parse bold content for nested inline code.
                    let mut inner = parse_inline(&text[start + 2..end]);
                    for s in &mut inner {
                        s.style = s.style.add_modifier(Modifier::BOLD);
                    }
                    spans.extend(inner);
                    pos = end + 2;
                }
                None => {
                    spans.push(Span::raw(text[pos..].to_string()));
                    break;
                }
            },
            None => {
                spans.push(Span::raw(text[pos..].to_string()));
                break;
            }
        }
    }

    spans
}

/// Which kind of inline marker appears first in the remaining text.
enum Marker {
    Code(usize),
    Bold(usize),
}

/// Return the earliest marker (code or bold) if any.
fn nearest_marker(code_at: Option<usize>, bold_at: Option<usize>) -> Option<Marker> {
    match (code_at, bold_at) {
        (Some(c), Some(b)) => {
            if c <= b {
                Some(Marker::Code(c))
            } else {
                Some(Marker::Bold(b))
            }
        }
        (Some(_), None) => code_at.map(Marker::Code),
        (None, Some(_)) => bold_at.map(Marker::Bold),
        (None, None) => None,
    }
}
