//! `/config`: change `[display]` settings on screen, without opening the file.
//!
//! Rows come from [`crate::tui::settings_catalog`]; this module is the surface:
//! which row is selected, which value is being considered, and what the screen
//! looks like. Applying is a separate step on purpose — arrowing across values
//! must be free to look at, because half of these settings are visual and the
//! only way to choose is to see the names side by side.
//!
//! ```text
//!   ⚙ settings                    type to filter
//!
//! > centered            ‹ false │ TRUE ›
//!   diagram_mode        ‹ none │ MARGIN │ pinned ›
//!
//!   ↑↓ setting   ←→ value   ⏎ apply   esc close
//! ```

use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

use crate::config::Config;
use crate::tui::settings_catalog::{self, Setting};

/// What the caller should do after a key was handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsOutcome {
    /// The overlay stays open.
    Stay,
    /// The user asked to leave.
    Close,
}

/// One row: a setting, the value it has, and the value being considered.
#[derive(Debug, Clone)]
pub struct SettingsRow {
    pub key: &'static str,
    pub help: &'static str,
    pub values: &'static [&'static str],
    /// Index into `values` of what is saved right now.
    pub current: usize,
    /// Index into `values` of what the arrows are pointing at.
    pub pending: usize,
}

impl SettingsRow {
    fn from_setting(setting: &'static Setting, config: &Config) -> Self {
        let current = setting.current_index(config);
        Self {
            key: setting.key,
            help: setting.help,
            values: setting.values,
            current,
            pending: current,
        }
    }

    /// Whether the arrows have moved off the saved value.
    pub fn is_dirty(&self) -> bool {
        self.pending != self.current
    }
}

pub struct SettingsOverlay {
    rows: Vec<SettingsRow>,
    /// Indices into `rows` that match the filter.
    filtered: Vec<usize>,
    /// Position within `filtered`.
    selected: usize,
    filter: String,
    /// Result of the last apply, shown in the footer.
    status: Option<String>,
}

impl SettingsOverlay {
    /// Build the overlay from the config on disk.
    pub fn new() -> Self {
        let config = Config::load();
        let rows: Vec<SettingsRow> = settings_catalog::display_settings()
            .iter()
            .map(|setting| SettingsRow::from_setting(setting, &config))
            .collect();
        let filtered = (0..rows.len()).collect();
        Self {
            rows,
            filtered,
            selected: 0,
            filter: String::new(),
            status: None,
        }
    }

    pub fn rows(&self) -> &[SettingsRow] {
        &self.rows
    }

    pub fn selected_row(&self) -> Option<&SettingsRow> {
        self.filtered.get(self.selected).map(|i| &self.rows[*i])
    }

    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    /// Handle one key. See the module docs for the bindings.
    pub fn handle_key(
        &mut self,
        code: crossterm::event::KeyCode,
        modifiers: crossterm::event::KeyModifiers,
    ) -> SettingsOutcome {
        use crossterm::event::{KeyCode, KeyModifiers};

        match code {
            KeyCode::Esc => return SettingsOutcome::Close,
            KeyCode::Char('c' | 'd') if modifiers.contains(KeyModifiers::CONTROL) => {
                return SettingsOutcome::Close;
            }
            KeyCode::Up => self.move_selection(-1),
            KeyCode::Down => self.move_selection(1),
            KeyCode::Char('p') if modifiers.contains(KeyModifiers::CONTROL) => {
                self.move_selection(-1)
            }
            KeyCode::Char('n') if modifiers.contains(KeyModifiers::CONTROL) => {
                self.move_selection(1)
            }
            KeyCode::Left => self.move_value(-1),
            KeyCode::Right => self.move_value(1),
            KeyCode::Enter => self.apply_selected(),
            KeyCode::Backspace => {
                self.filter.pop();
                self.refilter();
            }
            KeyCode::Char(c) if !modifiers.contains(KeyModifiers::CONTROL) => {
                self.filter.push(c);
                self.refilter();
            }
            _ => {}
        }
        SettingsOutcome::Stay
    }

    /// Move the selected row, abandoning any value the arrows were pointing at.
    ///
    /// Leaving an unapplied value behind on a row the user has walked away from
    /// would be a promise the overlay never keeps: the config still holds the
    /// old value, so the row must show it.
    fn move_selection(&mut self, delta: isize) {
        if self.filtered.is_empty() {
            return;
        }
        self.reset_pending();
        let len = self.filtered.len() as isize;
        let next = (self.selected as isize + delta).rem_euclid(len);
        self.selected = next as usize;
        self.status = None;
    }

    fn move_value(&mut self, delta: isize) {
        let Some(&row_index) = self.filtered.get(self.selected) else {
            return;
        };
        let row = &mut self.rows[row_index];
        let len = row.values.len() as isize;
        if len == 0 {
            return;
        }
        row.pending = ((row.pending as isize + delta).rem_euclid(len)) as usize;
        self.status = None;
    }

    fn reset_pending(&mut self) {
        if let Some(&row_index) = self.filtered.get(self.selected) {
            let row = &mut self.rows[row_index];
            row.pending = row.current;
        }
    }

    /// Write the selected row's pending value to the config file.
    fn apply_selected(&mut self) {
        let Some(&row_index) = self.filtered.get(self.selected) else {
            return;
        };
        let row = &self.rows[row_index];
        if !row.is_dirty() {
            self.status = Some(format!("{} is already {}", row.key, row.values[row.current]));
            return;
        }
        let key = row.key;
        let value = row.values[row.pending];

        match settings_catalog::apply(key, value) {
            Ok(()) => {
                self.rows[row_index].current = self.rows[row_index].pending;
                self.status = Some(format!("✓ {key} = {value}"));
                crate::logging::info(&format!("Settings: {key} = {value} (via /config)"));
            }
            Err(error) => {
                // Put the row back to what the file still says: a failed write
                // must not leave the screen claiming a value that was not saved.
                self.rows[row_index].pending = self.rows[row_index].current;
                self.status = Some(format!("could not save {key}: {error}"));
            }
        }
    }

    fn refilter(&mut self) {
        let needle = self.filter.trim().to_ascii_lowercase();
        self.filtered = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                needle.is_empty()
                    || row.key.contains(&needle)
                    || row.help.to_ascii_lowercase().contains(&needle)
            })
            .map(|(i, _)| i)
            .collect();
        self.selected = self.selected.min(self.filtered.len().saturating_sub(1));
    }

    /// Draw the overlay over the whole frame.
    pub fn render(&self, frame: &mut Frame) {
        let area = centered_rect(frame.area(), 72, 22);
        frame.render_widget(Clear, area);

        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::color::rgb(138, 180, 248));

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(dim)
            .title(Span::styled(" ⚙ display settings ", accent));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let mut lines: Vec<Line<'static>> = Vec::new();
        let header = if self.filter.is_empty() {
            "type to filter".to_string()
        } else {
            format!("filter: {}", self.filter)
        };
        lines.push(Line::from(Span::styled(header, dim)).alignment(Alignment::Right));

        // Keep the selected row on screen without storing a scroll position:
        // the window is derived from the selection every frame.
        let body_height = inner.height.saturating_sub(4) as usize;
        let start = self.selected.saturating_sub(body_height.saturating_sub(1));
        for (offset, row_index) in self.filtered.iter().skip(start).take(body_height).enumerate() {
            let row = &self.rows[*row_index];
            let is_selected = start + offset == self.selected;
            let mut spans = vec![Span::styled(
                format!("{} {:<20}", if is_selected { ">" } else { " " }, row.key),
                if is_selected { accent } else { dim },
            )];
            spans.extend(value_spans(row, is_selected, accent, dim));
            lines.push(Line::from(spans));
        }

        lines.push(Line::from(""));
        if let Some(row) = self.selected_row() {
            lines.push(Line::from(Span::styled(format!("  {}", row.help), dim)));
        }
        let footer = self
            .status
            .clone()
            .unwrap_or_else(|| "  ↑↓ setting   ←→ value   ⏎ apply   esc close".to_string());
        lines.push(Line::from(Span::styled(footer, dim)));

        frame.render_widget(Paragraph::new(lines), inner);
    }
}

impl Default for SettingsOverlay {
    fn default() -> Self {
        Self::new()
    }
}

/// `‹ false │ TRUE ›` — every value, with the pending one lit.
fn value_spans(
    row: &SettingsRow,
    is_selected: bool,
    accent: Style,
    dim: Style,
) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    if is_selected {
        spans.push(Span::styled("‹ ".to_string(), dim));
    } else {
        spans.push(Span::raw("  ".to_string()));
    }
    for (i, value) in row.values.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" │ ".to_string(), dim));
        }
        let style = if i == row.pending {
            if row.is_dirty() {
                accent.add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
            } else {
                accent.add_modifier(Modifier::BOLD)
            }
        } else {
            dim
        };
        spans.push(Span::styled((*value).to_string(), style));
    }
    if is_selected {
        spans.push(Span::styled(" ›".to_string(), dim));
    }
    spans
}

fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyModifiers};

    fn key(code: KeyCode) -> KeyModifiers {
        let _ = code;
        KeyModifiers::empty()
    }

    fn overlay() -> SettingsOverlay {
        // Built from the config on disk; tests only exercise navigation, which
        // does not care what the saved values are.
        SettingsOverlay::new()
    }

    #[test]
    fn arrows_move_the_value_without_saving_it() {
        let mut o = overlay();
        let before = o.selected_row().expect("a row").current;
        o.handle_key(KeyCode::Right, key(KeyCode::Right));
        let row = o.selected_row().expect("a row");
        assert_ne!(row.pending, before, "the arrow should move the value");
        assert_eq!(row.current, before, "and must not have saved it");
        assert!(row.is_dirty());
    }

    #[test]
    fn walking_away_from_a_row_abandons_its_pending_value() {
        let mut o = overlay();
        o.handle_key(KeyCode::Right, key(KeyCode::Right));
        assert!(o.selected_row().expect("a row").is_dirty());

        o.handle_key(KeyCode::Down, key(KeyCode::Down));
        o.handle_key(KeyCode::Up, key(KeyCode::Up));

        let row = o.selected_row().expect("a row");
        assert!(
            !row.is_dirty(),
            "a row the user left must show what the config still says"
        );
    }

    #[test]
    fn the_selection_wraps_at_both_ends() {
        let mut o = overlay();
        let count = o.filtered.len();
        assert!(count > 1);
        o.handle_key(KeyCode::Up, key(KeyCode::Up));
        assert_eq!(o.selected, count - 1, "up from the first row wraps to the last");
        o.handle_key(KeyCode::Down, key(KeyCode::Down));
        assert_eq!(o.selected, 0);
    }

    #[test]
    fn values_wrap_too() {
        let mut o = overlay();
        let len = o.selected_row().expect("a row").values.len();
        let start = o.selected_row().expect("a row").pending;
        for _ in 0..len {
            o.handle_key(KeyCode::Right, key(KeyCode::Right));
        }
        assert_eq!(
            o.selected_row().expect("a row").pending,
            start,
            "a full cycle returns to where it started"
        );
    }

    #[test]
    fn typing_filters_and_backspace_restores() {
        let mut o = overlay();
        let all = o.filtered.len();
        for c in "diagram".chars() {
            o.handle_key(KeyCode::Char(c), KeyModifiers::empty());
        }
        assert!(o.filtered.len() < all);
        assert!(
            o.selected_row().expect("a row").key.contains("diagram"),
            "the filter should leave only matching settings"
        );

        for _ in 0.."diagram".len() {
            o.handle_key(KeyCode::Backspace, KeyModifiers::empty());
        }
        assert_eq!(o.filtered.len(), all);
    }

    #[test]
    fn a_filter_that_matches_nothing_leaves_no_selection() {
        let mut o = overlay();
        for c in "zzzz".chars() {
            o.handle_key(KeyCode::Char(c), KeyModifiers::empty());
        }
        assert!(o.filtered.is_empty());
        assert!(o.selected_row().is_none());
        // Navigation on an empty list must not panic or index anything.
        o.handle_key(KeyCode::Down, KeyModifiers::empty());
        o.handle_key(KeyCode::Right, KeyModifiers::empty());
        o.handle_key(KeyCode::Enter, KeyModifiers::empty());
    }

    #[test]
    fn esc_and_ctrl_c_close() {
        let mut o = overlay();
        assert_eq!(
            o.handle_key(KeyCode::Esc, KeyModifiers::empty()),
            SettingsOutcome::Close
        );
        assert_eq!(
            o.handle_key(KeyCode::Char('c'), KeyModifiers::CONTROL),
            SettingsOutcome::Close
        );
    }

    #[test]
    fn enter_on_an_unchanged_row_says_so_instead_of_writing() {
        let mut o = overlay();
        o.handle_key(KeyCode::Enter, KeyModifiers::empty());
        let status = o.status().expect("a status line");
        assert!(
            status.contains("already"),
            "unchanged row should report, not save: {status}"
        );
    }
}
