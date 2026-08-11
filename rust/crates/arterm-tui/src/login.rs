//! Login / provider configuration overlay and model picker popup.
//!
//! These are modal overlays rendered on top of the normal TUI:
//!
//! - [`LoginState`] + [`render_login`]: a centered form for editing the
//!   provider name, API host, API key, and model. On Enter the values are
//!   written to `~/.arterm/config.json` via `arterm_config::save_config`.
//! - [`ModelPickerState`] + [`render_model_picker`]: a centered popup that
//!   lists known models and lets the user filter by typing. For now the list
//!   is empty and the user types a model name directly.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

use arterm_config::ArtermConfig;

/// Which input field in the login overlay is currently active.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginField {
    Provider,
    Host,
    Key,
    Model,
}

impl LoginField {
    /// Total number of fields, used to wrap the Tab cycle.
    pub const COUNT: usize = 4;

    /// Convert the enum variant to a 0-based index.
    pub fn as_index(self) -> usize {
        match self {
            LoginField::Provider => 0,
            LoginField::Host => 1,
            LoginField::Key => 2,
            LoginField::Model => 3,
        }
    }

    /// Reconstruct the field from a 0-based index (wraps modulo [`COUNT`]).
    pub fn from_index(idx: usize) -> Self {
        match idx % Self::COUNT {
            0 => LoginField::Provider,
            1 => LoginField::Host,
            2 => LoginField::Key,
            _ => LoginField::Model,
        }
    }

    /// Advance to the next field (Tab).
    pub fn next(self) -> Self {
        Self::from_index(self.as_index() + 1)
    }

    /// Go back to the previous field (Shift+Tab / BackTab).
    pub fn prev(self) -> Self {
        let n = Self::COUNT;
        Self::from_index((self.as_index() + n - 1) % n)
    }

    /// Human-readable label shown next to the input.
    pub fn label(self) -> &'static str {
        match self {
            LoginField::Provider => "Provider",
            LoginField::Host => "API Host",
            LoginField::Key => "API Key",
            LoginField::Model => "Model",
        }
    }
}

/// Mutable state for the login / provider-configuration overlay.
///
/// `field` is an index into the four inputs (see [`LoginField`]). `active`
/// gates whether the overlay is shown at all.
pub struct LoginState {
    pub active: bool,
    pub provider: String,
    pub host: String,
    pub key: String,
    pub model: String,
    pub field: usize,
}

impl LoginState {
    /// Start a new login overlay pre-filled from the current config so the
    /// user edits existing values rather than starting from scratch.
    pub fn from_config(config: &ArtermConfig) -> Self {
        Self {
            active: true,
            provider: config.provider.clone(),
            host: config.openai_compat_host.clone().unwrap_or_default(),
            key: config.openai_compat_key.clone().unwrap_or_default(),
            model: config.model.clone(),
            field: 0,
        }
    }

    /// The field currently being edited.
    pub fn current_field(&self) -> LoginField {
        LoginField::from_index(self.field)
    }

    /// Borrow the string for the active field mutably, for typing.
    pub fn active_text_mut(&mut self) -> &mut String {
        match self.current_field() {
            LoginField::Provider => &mut self.provider,
            LoginField::Host => &mut self.host,
            LoginField::Key => &mut self.key,
            LoginField::Model => &mut self.model,
        }
    }

    /// Apply the entered values to a config, returning the updated copy.
    /// Empty host/key are mapped back to `None`.
    pub fn apply_to_config(&self, mut config: ArtermConfig) -> ArtermConfig {
        config.provider = self.provider.trim().to_string();
        config.openai_compat_host = if self.host.trim().is_empty() {
            None
        } else {
            Some(self.host.trim().to_string())
        };
        config.openai_compat_key = if self.key.trim().is_empty() {
            None
        } else {
            Some(self.key.trim().to_string())
        };
        config.model = self.model.trim().to_string();
        config
    }
}

/// Compute a centered rectangle of at most `width` x `height` inside `area`.
fn centered_rect(area: Rect, width: u16, height: u16) -> Rect {
    // Clamp the popup to the available space so it never overflows on tiny
    // terminals; leave at least one cell of margin on each axis.
    let w = width.min(area.width.saturating_sub(2)).max(1);
    let h = height.min(area.height.saturating_sub(2)).max(1);

    let pop = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length((area.height.saturating_sub(h)) / 2),
            Constraint::Length(h),
            Constraint::Min(0),
        ])
        .split(area);

    let inner = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length((area.width.saturating_sub(w)) / 2),
            Constraint::Length(w),
            Constraint::Min(0),
        ])
        .split(pop[1]);

    inner[1]
}

/// Render the login overlay. Draws a translucent-clear background, a bordered
/// titled box, and the four labeled input fields with the active one
/// highlighted. A footer line hints at the keybindings.
pub fn render_login(frame: &mut Frame, area: Rect, state: &LoginState) {
    // Clear the underlying cells so the popup reads as a distinct layer.
    let popup = centered_rect(area, 64, 13);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Login / Configure Provider ")
        .title_alignment(Alignment::Center)
        .border_style(Style::default().fg(Color::Cyan))
        .style(Style::default().bg(Color::Black));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    // Four field rows + a footer hint row.
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Provider
            Constraint::Length(1), // Host
            Constraint::Length(1), // Key
            Constraint::Length(1), // Model
            Constraint::Length(1), // (spacer)
            Constraint::Length(1), // hint
            Constraint::Min(0),
        ])
        .split(inner);

    let fields = [
        (LoginField::Provider, &state.provider),
        (LoginField::Host, &state.host),
        (LoginField::Key, &state.key),
        (LoginField::Model, &state.model),
    ];

    let active = state.current_field();
    for (i, (field, value)) in fields.iter().enumerate() {
        let is_active = *field == active;
        let label = field.label();

        // Render as a single-styled Paragraph for the whole row; empty values
        // get a placeholder so the active field is visible even when blank.
        let display_value: String = if value.is_empty() && is_active {
            String::new()
        } else if value.is_empty() {
            "(empty)".to_string()
        } else {
            // Mask the API key the same way the TS Arterm does.
            if *field == LoginField::Key {
                "•".repeat(value.chars().count())
            } else {
                value.to_string()
            }
        };

        let cursor = if is_active { "_" } else { " " };
        let style = if is_active {
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };

        let line = Line::from(vec![
            Span::styled(
                format!("{label:<10}: "),
                Style::default().fg(Color::Cyan),
            ),
            Span::styled(format!("{display_value}{cursor}"), style),
        ]);
        frame.render_widget(Paragraph::new(line), rows[i]);
    }

    // Footer hint.
    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "Tab/Shift+Tab",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" cycle fields  "),
        Span::styled(
            "Enter",
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" save  "),
        Span::styled(
            "Esc",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" cancel"),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(hint, rows[5]);
}

/// Mutable state for the model-picker popup.
pub struct ModelPickerState {
    pub active: bool,
    /// Known model identifiers. Empty for now; the user types a name directly
    /// and the filter doubles as the chosen model on Enter.
    pub models: Vec<String>,
    pub selected: usize,
    pub filter: String,
}

impl ModelPickerState {
    /// Open the picker seeded with the current model.
    pub fn new(current_model: &str) -> Self {
        Self {
            active: true,
            models: Vec::new(),
            selected: 0,
            filter: current_model.to_string(),
        }
    }

    /// Models matching the current filter (case-insensitive substring).
    pub fn filtered_models(&self) -> Vec<&String> {
        if self.models.is_empty() {
            return Vec::new();
        }
        let needle = self.filter.trim().to_lowercase();
        if needle.is_empty() {
            self.models.iter().collect()
        } else {
            self.models
                .iter()
                .filter(|m| m.to_lowercase().contains(&needle))
                .collect()
        }
    }

    /// The model to commit on Enter. When the model list is empty the typed
    /// filter is the model name itself (per the task spec).
    pub fn chosen_model(&self) -> String {
        let filtered = self.filtered_models();
        if let Some(m) = filtered.get(self.selected.min(filtered.len().saturating_sub(1))) {
            (*m).clone()
        } else {
            self.filter.trim().to_string()
        }
    }

    /// Move the selection up, clamped to the top of the filtered list.
    pub fn select_up(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    /// Move the selection down, clamped to the bottom of the filtered list.
    pub fn select_down(&mut self) {
        let max = self.filtered_models().len().saturating_sub(1);
        if self.selected < max {
            self.selected += 1;
        }
    }
}

/// Render the model-picker popup. Shows a filter input at the top and the
/// filtered model list (if any) below. When there are no known models the
/// filter field is the model name the user is typing.
pub fn render_model_picker(frame: &mut Frame, area: Rect, state: &ModelPickerState) {
    let popup = centered_rect(area, 56, 14);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Select Model ")
        .title_alignment(Alignment::Center)
        .border_style(Style::default().fg(Color::Magenta))
        .style(Style::default().bg(Color::Black));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // filter input
            Constraint::Length(1), // spacer
            Constraint::Min(1),    // list
            Constraint::Length(1), // hint
        ])
        .split(inner);

    // Filter / direct entry field.
    let filter_line = Line::from(vec![
        Span::styled("Model: ", Style::default().fg(Color::Magenta)),
        Span::styled(
            format!("{}_", state.filter),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(Paragraph::new(filter_line), chunks[0]);

    // Model list (if the provider supplied any).
    let filtered = state.filtered_models();
    if filtered.is_empty() {
        frame.render_widget(
            Paragraph::new("Type a model name, then press Enter.")
                .style(Style::default().fg(Color::DarkGray)),
            chunks[2],
        );
    } else {
        let items: Vec<ListItem> = filtered
            .iter()
            .map(|m| ListItem::new(m.as_str().to_string()))
            .collect();
        let mut list_state = ListState::default();
        list_state.select(Some(state.selected.min(filtered.len().saturating_sub(1))));
        let list = List::new(items)
            .highlight_style(
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )
            .highlight_symbol("▶ ");
        frame.render_stateful_widget(list, chunks[2], &mut list_state);
    }

    // Hint footer.
    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "Up/Down",
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" select  "),
        Span::styled(
            "Enter",
            Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" confirm  "),
        Span::styled(
            "Esc",
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" cancel"),
    ]))
    .alignment(Alignment::Center);
    frame.render_widget(hint, chunks[3]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_cycle_wraps() {
        assert_eq!(LoginField::Provider.next(), LoginField::Host);
        assert_eq!(LoginField::Model.next(), LoginField::Provider);
        assert_eq!(LoginField::Provider.prev(), LoginField::Model);
    }

    #[test]
    fn apply_to_config_maps_empty_to_none() {
        let mut s = LoginState {
            active: true,
            provider: "openai-compat".into(),
            host: "".into(),
            key: "".into(),
            model: "gpt-4o".into(),
            field: 0,
        };
        let cfg = s.apply_to_config(ArtermConfig::default());
        assert_eq!(cfg.provider, "openai-compat");
        assert_eq!(cfg.openai_compat_host, None);
        assert_eq!(cfg.openai_compat_key, None);
        assert_eq!(cfg.model, "gpt-4o");

        s.host = "https://api.example.com/v1 ".into();
        s.key = " sk-123 ".into();
        let cfg = s.apply_to_config(ArtermConfig::default());
        assert_eq!(cfg.openai_compat_host.as_deref(), Some("https://api.example.com/v1"));
        assert_eq!(cfg.openai_compat_key.as_deref(), Some("sk-123"));
    }

    #[test]
    fn active_text_mut_targets_current_field() {
        let mut s = LoginState {
            active: true,
            provider: String::new(),
            host: String::new(),
            key: String::new(),
            model: String::new(),
            field: LoginField::Model.as_index(),
        };
        s.active_text_mut().push_str("qwen2.5:7b");
        assert_eq!(s.model, "qwen2.5:7b");
    }

    #[test]
    fn model_picker_chooses_filter_when_no_models() {
        let mut s = ModelPickerState::new("qwen2.5:7b");
        assert_eq!(s.chosen_model(), "qwen2.5:7b");
        s.filter.push_str(" mini");
        assert_eq!(s.chosen_model(), "qwen2.5:7b mini");
    }

    #[test]
    fn model_picker_filters_and_clamps_selection() {
        let mut s = ModelPickerState {
            active: true,
            models: vec!["gpt-4o".into(), "gpt-4o-mini".into(), "claude".into()],
            selected: 0,
            filter: "gpt".into(),
        };
        assert_eq!(s.filtered_models().len(), 2);
        s.select_down();
        assert_eq!(s.selected, 1);
        s.select_down(); // would go past end; clamped
        assert_eq!(s.selected, 1);
        assert_eq!(s.chosen_model(), "gpt-4o-mini");
    }
}
