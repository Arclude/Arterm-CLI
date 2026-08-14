//! `/mcp` overlay: interactive MCP server status and management.
//!
//! Three stacked views, all in one modal: the server list (colored state per
//! row), a per-server detail card with an action menu, and a scrollable tool
//! list. The App side owns the data: rows are built from the client's MCP
//! status cache plus the on-disk config, actions are routed to the server as
//! `Request::McpAction` (remote sessions), and refreshed state arrives back
//! as `McpStatus` / `McpToolList` events.
//!
//! ```text
//!  MCP servers
//!
//!  ● ida-pro-mcp     connected · 48 tools
//!  ○ demo            not connected
//!
//!    ↑↓ navigate   ⏎ open   r reload all   esc close
//! ```

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use crate::mcp::McpServerSource;

/// Connection state of one server, as the client knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpServerState {
    Connected { tool_count: usize },
    Connecting,
    NotConnected { reason: Option<String> },
    Disabled,
}

/// Everything the overlay shows about one server.
#[derive(Debug, Clone)]
pub struct McpServerRow {
    pub name: String,
    pub state: McpServerState,
    pub command: String,
    pub args: Vec<String>,
    pub source: McpServerSource,
    pub shared: bool,
    /// Tool names, when known (local sessions know at open; remote sessions
    /// fetch on demand). `None` = not fetched yet.
    pub tools: Option<Vec<String>>,
}

/// What the caller should do after a key was handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpPickerOutcome {
    Stay,
    Close,
    /// Run an MCP action ("connect" | "reconnect" | "disconnect" | "reload"
    /// | "tools") for `server` (None only for "reload").
    Action {
        action: &'static str,
        server: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum McpView {
    List,
    Detail { menu_index: usize },
    Tools { scroll: usize },
}

/// One selectable action row in the detail menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuItem {
    ViewTools,
    Connect,
    Reconnect,
    Disconnect,
}

impl MenuItem {
    fn label(self) -> &'static str {
        match self {
            Self::ViewTools => "View tools",
            Self::Connect => "Connect",
            Self::Reconnect => "Reconnect",
            Self::Disconnect => "Disconnect",
        }
    }
}

pub struct McpPicker {
    rows: Vec<McpServerRow>,
    selected: usize,
    view: McpView,
    /// Footer status override (action results / in-flight note); falls back
    /// to the key hints when `None`.
    status: Option<String>,
}

impl McpPicker {
    pub fn new(rows: Vec<McpServerRow>) -> Self {
        Self {
            rows,
            selected: 0,
            view: McpView::List,
            status: None,
        }
    }

    fn selected_row(&self) -> Option<&McpServerRow> {
        self.rows.get(self.selected)
    }

    /// Replace the rows with a fresh snapshot (a `McpStatus` event landed),
    /// keeping the selection and, when possible, the current view.
    pub fn set_rows(&mut self, rows: Vec<McpServerRow>) {
        let selected_name = self.selected_row().map(|row| row.name.clone());
        // Keep already-fetched tool lists: status refreshes carry counts only.
        let mut rows = rows;
        for row in &mut rows {
            if row.tools.is_none()
                && let Some(existing) = self
                    .rows
                    .iter()
                    .find(|old| old.name == row.name && old.tools.is_some())
            {
                row.tools = existing.tools.clone();
            }
        }
        self.rows = rows;
        match selected_name.and_then(|name| self.rows.iter().position(|row| row.name == name)) {
            Some(index) => self.selected = index,
            None => {
                self.selected = 0;
                self.view = McpView::List;
            }
        }
        // An action completed and the world changed; the fresh state on
        // screen replaces the "working..." note.
        if self.status.as_deref().is_some_and(|s| s.starts_with('⏳')) {
            self.status = None;
        }
    }

    /// Record fetched tool names for `server` (a `McpToolList` event landed).
    pub fn set_tools(&mut self, server: &str, tools: Vec<String>) {
        if let Some(row) = self.rows.iter_mut().find(|row| row.name == server) {
            row.tools = Some(tools);
        }
    }

    /// Show an action result (or failure) in the footer.
    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
    }

    fn menu_items(row: &McpServerRow) -> Vec<MenuItem> {
        match row.state {
            McpServerState::Connected { .. } | McpServerState::Connecting => {
                vec![
                    MenuItem::ViewTools,
                    MenuItem::Reconnect,
                    MenuItem::Disconnect,
                ]
            }
            McpServerState::NotConnected { .. } | McpServerState::Disabled => {
                vec![MenuItem::Connect]
            }
        }
    }

    /// Handle one key. Returns what the caller should do.
    pub fn handle_key(
        &mut self,
        code: crossterm::event::KeyCode,
        _modifiers: crossterm::event::KeyModifiers,
    ) -> McpPickerOutcome {
        use crossterm::event::KeyCode;

        match self.view.clone() {
            McpView::List => match code {
                KeyCode::Esc | KeyCode::Char('q') => McpPickerOutcome::Close,
                KeyCode::Up | KeyCode::Char('k') => {
                    self.selected = self.selected.saturating_sub(1);
                    McpPickerOutcome::Stay
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if self.selected + 1 < self.rows.len() {
                        self.selected += 1;
                    }
                    McpPickerOutcome::Stay
                }
                KeyCode::Enter => {
                    if self.selected_row().is_some() {
                        self.view = McpView::Detail { menu_index: 0 };
                    }
                    McpPickerOutcome::Stay
                }
                KeyCode::Char('r') => {
                    self.status = Some("⏳ reloading MCP config...".to_string());
                    McpPickerOutcome::Action {
                        action: "reload",
                        server: None,
                    }
                }
                _ => McpPickerOutcome::Stay,
            },
            McpView::Detail { menu_index } => {
                let Some(row) = self.selected_row() else {
                    self.view = McpView::List;
                    return McpPickerOutcome::Stay;
                };
                let items = Self::menu_items(row);
                let server = row.name.clone();
                let has_tools = row.tools.is_some();
                match code {
                    KeyCode::Esc => {
                        self.view = McpView::List;
                        McpPickerOutcome::Stay
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        self.view = McpView::Detail {
                            menu_index: menu_index.saturating_sub(1),
                        };
                        McpPickerOutcome::Stay
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        self.view = McpView::Detail {
                            menu_index: (menu_index + 1).min(items.len().saturating_sub(1)),
                        };
                        McpPickerOutcome::Stay
                    }
                    KeyCode::Enter => match items.get(menu_index) {
                        Some(MenuItem::ViewTools) => {
                            self.view = McpView::Tools { scroll: 0 };
                            if has_tools {
                                McpPickerOutcome::Stay
                            } else {
                                McpPickerOutcome::Action {
                                    action: "tools",
                                    server: Some(server),
                                }
                            }
                        }
                        Some(MenuItem::Connect) => {
                            self.status = Some(format!("⏳ connecting {}...", server));
                            McpPickerOutcome::Action {
                                action: "connect",
                                server: Some(server),
                            }
                        }
                        Some(MenuItem::Reconnect) => {
                            self.status = Some(format!("⏳ reconnecting {}...", server));
                            McpPickerOutcome::Action {
                                action: "reconnect",
                                server: Some(server),
                            }
                        }
                        Some(MenuItem::Disconnect) => {
                            self.status = Some(format!("⏳ disconnecting {}...", server));
                            McpPickerOutcome::Action {
                                action: "disconnect",
                                server: Some(server),
                            }
                        }
                        None => McpPickerOutcome::Stay,
                    },
                    _ => McpPickerOutcome::Stay,
                }
            }
            McpView::Tools { scroll } => match code {
                KeyCode::Esc => {
                    self.view = McpView::Detail { menu_index: 0 };
                    McpPickerOutcome::Stay
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    self.view = McpView::Tools {
                        scroll: scroll.saturating_sub(1),
                    };
                    McpPickerOutcome::Stay
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    let max = self
                        .selected_row()
                        .and_then(|row| row.tools.as_ref())
                        .map(|tools| tools.len().saturating_sub(1))
                        .unwrap_or(0);
                    self.view = McpView::Tools {
                        scroll: (scroll + 1).min(max),
                    };
                    McpPickerOutcome::Stay
                }
                _ => McpPickerOutcome::Stay,
            },
        }
    }

    /// Draw the overlay over the whole frame.
    pub fn render(&self, frame: &mut Frame) {
        let area = centered_rect(frame.area(), 76, 24);
        frame.render_widget(Clear, area);

        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::theme::accent_color());
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(dim)
            .title(Span::styled(" MCP servers ", accent));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let mut lines: Vec<Line<'static>> = Vec::new();
        match &self.view {
            McpView::List => self.render_list(&mut lines, inner),
            McpView::Detail { menu_index } => self.render_detail(&mut lines, *menu_index),
            McpView::Tools { scroll } => self.render_tools(&mut lines, *scroll, inner),
        }

        lines.push(Line::from(""));
        let hints = match &self.view {
            McpView::List => "  ↑↓ navigate   ⏎ open   r reload all   esc close",
            McpView::Detail { .. } => "  ↑↓ navigate   ⏎ select   esc back",
            McpView::Tools { .. } => "  ↑↓ scroll   esc back",
        };
        let footer = self.status.clone().unwrap_or_else(|| hints.to_string());
        lines.push(Line::from(Span::styled(footer, dim)));

        frame.render_widget(Paragraph::new(lines), inner);
    }

    fn state_span(state: &McpServerState) -> (Span<'static>, Span<'static>) {
        let success = Style::default().fg(arterm_tui_style::theme::success_color());
        let warning = Style::default().fg(arterm_tui_style::theme::warning_color());
        let error = Style::default().fg(arterm_tui_style::theme::error_color());
        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        match state {
            McpServerState::Connected { tool_count } => {
                let noun = if *tool_count == 1 { "tool" } else { "tools" };
                (
                    Span::styled("● ", success),
                    Span::styled(format!("connected · {} {}", tool_count, noun), success),
                )
            }
            McpServerState::Connecting => (
                Span::styled("◐ ", warning),
                Span::styled("connecting...".to_string(), warning),
            ),
            McpServerState::NotConnected { reason } => (
                Span::styled("○ ", error),
                match reason {
                    Some(reason) => Span::styled(format!("not connected: {}", reason), error),
                    None => Span::styled("not connected".to_string(), error),
                },
            ),
            McpServerState::Disabled => (
                Span::styled("○ ", dim),
                Span::styled("disabled in config".to_string(), dim),
            ),
        }
    }

    fn render_list(&self, lines: &mut Vec<Line<'static>>, inner: Rect) {
        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::theme::accent_color());

        if self.rows.is_empty() {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  No MCP servers configured.".to_string(),
                dim,
            )));
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  Add one from a terminal:  arterm mcp add <name> <command> [args...]".to_string(),
                dim,
            )));
            return;
        }

        lines.push(Line::from(""));
        let body_height = inner.height.saturating_sub(4) as usize;
        let start = self.selected.saturating_sub(body_height.saturating_sub(1));
        for (offset, row) in self.rows.iter().skip(start).take(body_height).enumerate() {
            let is_selected = start + offset == self.selected;
            let (dot, state) = Self::state_span(&row.state);
            let marker = if is_selected { "❯ " } else { "  " };
            let name_style = if is_selected {
                accent.add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            lines.push(Line::from(vec![
                Span::styled(marker.to_string(), accent),
                dot,
                Span::styled(format!("{:<20}", row.name), name_style),
                state,
            ]));
        }
    }

    fn render_detail(&self, lines: &mut Vec<Line<'static>>, menu_index: usize) {
        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::theme::accent_color());
        let Some(row) = self.selected_row() else {
            return;
        };

        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("  {}", row.name),
            accent.add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));

        let label = |text: &str| Span::styled(format!("  {:<17}", text), dim);
        let (_, state_span) = Self::state_span(&row.state);
        lines.push(Line::from(vec![label("Status:"), state_span]));

        let mut command = row.command.clone();
        if !row.args.is_empty() {
            command.push(' ');
            command.push_str(&row.args.join(" "));
        }
        lines.push(Line::from(vec![label("Command:"), Span::raw(command)]));
        lines.push(Line::from(vec![
            label("Config location:"),
            Span::raw(row.source.label().to_string()),
        ]));
        lines.push(Line::from(vec![
            label("Shared:"),
            Span::raw(if row.shared {
                "yes (one process for all sessions)"
            } else {
                "no (one process per session)"
            }),
        ]));
        if let McpServerState::Connected { tool_count } = row.state {
            lines.push(Line::from(vec![
                label("Tools:"),
                Span::raw(format!("{} tools (mcp__{}__<tool>)", tool_count, row.name)),
            ]));
        }
        if !row.source.is_editable() {
            lines.push(Line::from(Span::styled(
                "  Definition is managed by the imported config; edit it there.".to_string(),
                dim,
            )));
        }

        lines.push(Line::from(""));
        for (index, item) in Self::menu_items(row).iter().enumerate() {
            let is_selected = index == menu_index;
            let marker = if is_selected { "❯ " } else { "  " };
            let style = if is_selected {
                accent.add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            lines.push(Line::from(vec![
                Span::styled(format!("  {}", marker), accent),
                Span::styled(format!("{}. {}", index + 1, item.label()), style),
            ]));
        }
    }

    fn render_tools(&self, lines: &mut Vec<Line<'static>>, scroll: usize, inner: Rect) {
        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::theme::accent_color());
        let Some(row) = self.selected_row() else {
            return;
        };

        lines.push(Line::from(""));
        match &row.tools {
            None => {
                lines.push(Line::from(Span::styled(
                    format!("  Fetching tools for {}...", row.name),
                    dim,
                )));
            }
            Some(tools) if tools.is_empty() => {
                lines.push(Line::from(Span::styled(
                    format!("  {} exposes no tools.", row.name),
                    dim,
                )));
            }
            Some(tools) => {
                lines.push(Line::from(vec![
                    Span::styled(format!("  {} — ", row.name), accent),
                    Span::styled(format!("{} tools", tools.len()), dim),
                ]));
                lines.push(Line::from(""));
                let body_height = inner.height.saturating_sub(6) as usize;
                for tool in tools.iter().skip(scroll).take(body_height) {
                    lines.push(Line::from(vec![
                        Span::styled("    mcp__".to_string(), dim),
                        Span::styled(format!("{}__", row.name), dim),
                        Span::raw(tool.clone()),
                    ]));
                }
                if tools.len() > scroll + body_height {
                    lines.push(Line::from(Span::styled(
                        format!("    … {} more", tools.len() - scroll - body_height),
                        dim,
                    )));
                }
            }
        }
    }
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
    use ratatui::{Terminal, backend::TestBackend};

    fn rows() -> Vec<McpServerRow> {
        vec![
            McpServerRow {
                name: "alpha".to_string(),
                state: McpServerState::Connected { tool_count: 3 },
                command: "python3".to_string(),
                args: vec!["server.py".to_string()],
                source: McpServerSource::Imported,
                shared: true,
                tools: Some(vec![
                    "one".to_string(),
                    "two".to_string(),
                    "three".to_string(),
                ]),
            },
            McpServerRow {
                name: "beta".to_string(),
                state: McpServerState::NotConnected {
                    reason: Some("spawn failed".to_string()),
                },
                command: "beta-server".to_string(),
                args: vec![],
                source: McpServerSource::User,
                shared: true,
                tools: None,
            },
        ]
    }

    fn key(picker: &mut McpPicker, code: KeyCode) -> McpPickerOutcome {
        picker.handle_key(code, KeyModifiers::empty())
    }

    fn rendered_text(picker: &McpPicker) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| picker.render(frame)).expect("draw");
        let buffer = terminal.backend().buffer();
        let area = buffer.area;
        let mut out = String::new();
        for y in area.y..area.y + area.height {
            for x in area.x..area.x + area.width {
                out.push_str(buffer[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn list_renders_colored_states_and_opens_detail() {
        let mut picker = McpPicker::new(rows());
        let text = rendered_text(&picker);
        assert!(text.contains("alpha"), "{text}");
        assert!(text.contains("connected · 3 tools"), "{text}");
        assert!(text.contains("not connected: spawn failed"), "{text}");

        assert_eq!(key(&mut picker, KeyCode::Enter), McpPickerOutcome::Stay);
        let text = rendered_text(&picker);
        assert!(text.contains("Status:"), "{text}");
        assert!(text.contains("Config location:"), "{text}");
        assert!(
            text.contains("imported (Claude Code/Codex config)"),
            "{text}"
        );
        assert!(text.contains("1. View tools"), "{text}");
        assert!(text.contains("2. Reconnect"), "{text}");
        assert!(text.contains("3. Disconnect"), "{text}");
    }

    #[test]
    fn detail_menu_runs_actions_for_the_selected_server() {
        let mut picker = McpPicker::new(rows());
        key(&mut picker, KeyCode::Enter);
        key(&mut picker, KeyCode::Down);
        assert_eq!(
            key(&mut picker, KeyCode::Enter),
            McpPickerOutcome::Action {
                action: "reconnect",
                server: Some("alpha".to_string()),
            }
        );

        // A not-connected server only offers Connect.
        let mut picker = McpPicker::new(rows());
        key(&mut picker, KeyCode::Down);
        key(&mut picker, KeyCode::Enter);
        assert_eq!(
            key(&mut picker, KeyCode::Enter),
            McpPickerOutcome::Action {
                action: "connect",
                server: Some("beta".to_string()),
            }
        );
    }

    #[test]
    fn view_tools_shows_known_tools_and_fetches_unknown_ones() {
        let mut picker = McpPicker::new(rows());
        key(&mut picker, KeyCode::Enter);
        assert_eq!(key(&mut picker, KeyCode::Enter), McpPickerOutcome::Stay);
        let text = rendered_text(&picker);
        assert!(text.contains("mcp__alpha__one"), "{text}");

        // beta has no cached tools: entering the tools view requests them.
        let mut picker = McpPicker::new(vec![McpServerRow {
            state: McpServerState::Connected { tool_count: 2 },
            tools: None,
            ..rows().remove(1)
        }]);
        key(&mut picker, KeyCode::Enter);
        assert_eq!(
            key(&mut picker, KeyCode::Enter),
            McpPickerOutcome::Action {
                action: "tools",
                server: Some("beta".to_string()),
            }
        );
        let text = rendered_text(&picker);
        assert!(text.contains("Fetching tools for beta"), "{text}");
        picker.set_tools("beta", vec!["scan".to_string()]);
        let text = rendered_text(&picker);
        assert!(text.contains("mcp__beta__scan"), "{text}");
    }

    #[test]
    fn esc_walks_back_through_views_and_closes_from_the_list() {
        let mut picker = McpPicker::new(rows());
        key(&mut picker, KeyCode::Enter);
        assert_eq!(key(&mut picker, KeyCode::Enter), McpPickerOutcome::Stay);
        assert_eq!(key(&mut picker, KeyCode::Esc), McpPickerOutcome::Stay);
        let text = rendered_text(&picker);
        assert!(text.contains("1. View tools"), "{text}");
        assert_eq!(key(&mut picker, KeyCode::Esc), McpPickerOutcome::Stay);
        assert_eq!(key(&mut picker, KeyCode::Esc), McpPickerOutcome::Close);
    }

    #[test]
    fn status_refresh_keeps_selection_and_cached_tools() {
        let mut picker = McpPicker::new(rows());
        key(&mut picker, KeyCode::Down);
        let mut refreshed = rows();
        refreshed[0].tools = None;
        picker.set_rows(refreshed);
        assert_eq!(
            picker.selected_row().map(|row| row.name.as_str()),
            Some("beta")
        );
        assert!(
            picker.rows[0].tools.is_some(),
            "already-fetched tools must survive a status refresh"
        );
    }
}
