pub mod agent;
mod copy_selection;
mod markdown;

use anyhow::Result;
use crossterm::{
    cursor::Show,
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseEvent, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph},
    Terminal,
};
use std::io::{self, Stdout};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use arterm_config::ArtermConfig;
use agent::{Agent, AgentEvent};
use copy_selection::SelectionState;

/// A transcript entry rendered in the TUI.
enum TranscriptEntry {
    User(String),
    Assistant(String),
    System(String),
    ToolCall { name: String, args: String },
    ToolResult { name: String, output: String, is_error: bool },
}

/// The main TUI application.
///
/// Owns terminal and display state but **not** the [`Agent`]. Communication
/// with the agent happens through channels created in [`App::run`]: a sender
/// for user input and a receiver for agent events.
pub struct App {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    messages: Vec<TranscriptEntry>,
    input: String,
    live: String,
    agent_busy: bool,
    scroll_offset: usize,
    /// Mouse drag-to-select state for the transcript.
    selection: SelectionState,
}

impl App {
    /// Initialise the terminal (alternate screen + raw mode + mouse capture).
    ///
    /// A panic hook is installed so that if the application crashes the
    /// terminal is restored before the panic message is printed.
    pub fn new() -> Result<Self> {
        // Panic hook: restore the terminal before the default handler prints
        // the panic info, so a crash never leaves the terminal in raw mode.
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = disable_raw_mode();
            let mut stdout = io::stdout();
            let _ = execute!(stdout, LeaveAlternateScreen, DisableMouseCapture, Show);
            default_hook(info);
        }));

        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
        let backend = CrosstermBackend::new(stdout);
        let terminal = Terminal::new(backend)?;
        Ok(Self {
            terminal,
            messages: Vec::new(),
            input: String::new(),
            live: String::new(),
            agent_busy: false,
            scroll_offset: 0,
            selection: SelectionState::default(),
        })
    }

    /// Run the async event loop.
    ///
    /// Polls **both** crossterm keyboard events and agent events (via a tokio
    /// mpsc channel) with a 50 ms timeout so streaming text and keyboard input
    /// are handled concurrently. The agent turn runs in a separate
    /// `tokio::spawn` task, keeping the UI responsive.
    pub async fn run(&mut self, config: &ArtermConfig) -> Result<()> {
        // Build provider and tools.
        let provider = arterm_providers::build_provider(
            &config.provider,
            &config.model,
            config.openai_compat_host.as_deref(),
            config.openai_compat_key.as_deref(),
        )?;

        let system = format!(
            "You are Arterm, a terminal AI coding agent. You help with coding, file \
             editing, and system tasks.\nProvider: {} Model: {}",
            config.provider, config.model
        );

        // ── Channels ───────────────────────────────────────────────────────
        //   user_tx  → user_rx : TUI sends user messages to the agent task
        //   agent_tx → agent_rx: agent task sends events back to the TUI
        let (user_tx, mut user_rx) = mpsc::unbounded_channel::<String>();
        let (agent_tx, mut agent_rx) = mpsc::unbounded_channel::<AgentEvent>();

        // ── Spawn the agent task (owns the Agent) ──────────────────────────
        {
            let mut agent = Agent {
                messages: Vec::new(),
                provider: Arc::from(provider),
                tools: arterm_tools::ToolRegistry::defaults(),
                system,
                permissions: arterm_core::PermissionManager::default(),
            };
            let agent_tx = agent_tx;
            tokio::spawn(async move {
                loop {
                    match user_rx.recv().await {
                        Some(input) => {
                            agent.push_user(&input);
                            if let Err(e) = agent.run_turn(&agent_tx).await {
                                let _ = agent_tx.send(AgentEvent::Error(e.to_string()));
                            }
                        }
                        None => break, // user_tx dropped → app is quitting
                    }
                }
            });
        }

        // Welcome banner.
        self.messages.push(TranscriptEntry::System(format!(
            "Arterm {} · {}/{} · Type a message and press Enter. Press Ctrl+C twice to quit.",
            env!("CARGO_PKG_VERSION"),
            config.provider,
            config.model
        )));

        // Track first Ctrl+C press for the two-press-to-quit pattern.
        let mut last_ctrl_c: Option<Instant> = None;

        // ── Main event loop ────────────────────────────────────────────────
        loop {
            self.draw(config)?;

            // Drain agent events (non-blocking) — update display state.
            while let Ok(ev) = agent_rx.try_recv() {
                self.handle_agent_event(ev);
            }

            // Poll for keyboard events with a 50 ms timeout.
            if event::poll(Duration::from_millis(50))? {
                match event::read()? {
                    Event::Key(key) => {
                        if key.kind != KeyEventKind::Press {
                            continue;
                        }
                        match key.code {
                            // ── Submit input ────────────────────────────────
                            KeyCode::Enter => {
                                if self.agent_busy {
                                    continue;
                                }
                                let input = std::mem::take(&mut self.input);
                                if input.trim().is_empty() {
                                    continue;
                                }
                                if input.trim() == "/exit" || input.trim() == "/quit" {
                                    break;
                                }
                                self.messages.push(TranscriptEntry::User(input.clone()));
                                self.agent_busy = true;
                                self.live.clear();
                                self.scroll_offset = 0;
                                let _ = user_tx.send(input);
                            }
                            // ── Ctrl+C → quit (two-press within 3 s) ─────────
                            KeyCode::Char('c')
                                if key.modifiers.contains(KeyModifiers::CONTROL) =>
                            {
                                match last_ctrl_c {
                                    Some(t) if t.elapsed() < Duration::from_secs(3) => break,
                                    _ => {
                                        last_ctrl_c = Some(Instant::now());
                                        self.messages.push(TranscriptEntry::System(
                                            "Press Ctrl+C again to quit.".to_string(),
                                        ));
                                    }
                                }
                            }
                            // ── Type characters ─────────────────────────────
                            KeyCode::Char(c) => {
                                self.input.push(c);
                            }
                            KeyCode::Backspace => {
                                self.input.pop();
                            }
                            // ── Scroll ──────────────────────────────────────
                            KeyCode::Up => {
                                self.scroll_offset = self.scroll_offset.saturating_add(1);
                            }
                            KeyCode::Down => {
                                self.scroll_offset = self.scroll_offset.saturating_sub(1);
                            }
                            KeyCode::PageUp => {
                                self.scroll_offset = self.scroll_offset.saturating_add(10);
                            }
                            KeyCode::PageDown => {
                                self.scroll_offset = self.scroll_offset.saturating_sub(10);
                            }
                            _ => {}
                        }
                    }
                    // ── Mouse drag-to-select + wheel scroll ────────────────
                    Event::Mouse(mouse) => self.handle_mouse_event(mouse),
                    _ => {}
                }
            }
        }

        Ok(())
    }

    /// Apply an agent event to display state.
    fn handle_agent_event(&mut self, ev: AgentEvent) {
        match ev {
            AgentEvent::TextDelta(d) => {
                self.live.push_str(&d);
                self.scroll_offset = 0;
            }
            AgentEvent::AssistantMessage(text) => {
                self.live.clear();
                self.messages.push(TranscriptEntry::Assistant(text));
                self.scroll_offset = 0;
            }
            AgentEvent::ToolCall { name, args } => {
                self.messages.push(TranscriptEntry::ToolCall { name, args });
                self.scroll_offset = 0;
            }
            AgentEvent::ToolResult { name, output, is_error } => {
                self.messages
                    .push(TranscriptEntry::ToolResult { name, output, is_error });
                self.scroll_offset = 0;
            }
            AgentEvent::TurnEnd => {
                self.agent_busy = false;
                self.live.clear();
            }
            AgentEvent::PermissionRequest { tool_name, message, .. } => {
                self.messages.push(TranscriptEntry::System(format!(
                    "permission required: {tool_name} — {message}"
                )));
                self.scroll_offset = 0;
            }
            AgentEvent::Error(e) => {
                self.live.clear();
                self.agent_busy = false;
                self.messages.push(TranscriptEntry::System(format!("Error: {e}")));
                self.scroll_offset = 0;
            }
        }
    }

    /// Handle a crossterm mouse event: start/extend/finish a drag selection or
    /// scroll the transcript with the wheel.
    ///
    /// Mouse coordinates are screen-relative. The transcript occupies the top
    /// layout chunk (`chunks[0]` in [`App::draw`]); its screen y-origin is at
    /// row 0 of the terminal, so `mouse.row` maps directly to a transcript
    /// line *index* once the current scroll state is accounted for. Because the
    /// selection needs to be stable across redraws (which recompute the visible
    /// window), we store coordinates relative to the **visible window**: the
    /// row is an index into the displayed lines, the column is the cell within
    /// that line.
    fn handle_mouse_event(&mut self, mouse: MouseEvent) {
        use crossterm::event::MouseButton;

        // The transcript area starts at terminal row 0 (top of screen) and
        // spans `transcript_height` rows. Rows outside this band are ignored
        // for selection (e.g. a click in the input box or status line).
        let transcript_height = self.transcript_height();

        // Clamp the mouse row into the transcript band so a drag that overshoots
        // the top or bottom edge of the transcript still extends the selection
        // to the boundary line, just like a native terminal.
        let screen_row = mouse.row.min(transcript_height.saturating_sub(1).max(0));
        let screen_col = mouse.column;

        let action = self
            .selection
            .handle_mouse(screen_row, screen_col, mouse.kind);

        match (mouse.kind, action) {
            (MouseEventKind::Up(MouseButton::Left), _) => {
                // On mouse-up, extract the selected text from the currently
                // visible transcript lines and copy it to the clipboard, then
                // clear the selection so the highlight disappears.
                let lines = self.visible_transcript_text();
                if let Some(text) = self.selection.selected_text(&lines) {
                    // Spawn the clipboard copy off the UI thread so a slow or
                    // missing helper never blocks rendering.
                    let text = text.clone();
                    std::thread::spawn(move || {
                        copy_selection::copy_to_clipboard(&text);
                    });
                }
                self.selection.clear();
            }
            (MouseEventKind::ScrollUp, _) => {
                self.scroll_offset = self.scroll_offset.saturating_add(3);
            }
            (MouseEventKind::ScrollDown, _) => {
                self.scroll_offset = self.scroll_offset.saturating_sub(3);
            }
            _ => {}
        }
    }

    /// The height (in rows) of the transcript area, computed from the same
    /// layout used by [`App::draw`].
    fn transcript_height(&self) -> u16 {
        // The layout reserves 3 rows for the input box and 1 for the status
        // line; everything else is the transcript (`Constraint::Min(1)`).
        let total = self.terminal.size().map(|r| r.height).unwrap_or(0);
        total.saturating_sub(3 + 1)
    }

    /// The plain-text content of each currently visible transcript line, in
    /// top-to-bottom display order.
    ///
    /// This is the same set of lines [`App::draw`] renders (after scroll
    /// offset is applied), expressed as owned `String`s so the selection logic
    /// can index into them by row/column. The text is produced alongside the
    /// styled [`ListItem`]s so it always matches what is on screen.
    fn visible_transcript_text(&self) -> Vec<String> {
        let mut lines = Self::build_transcript_text(&self.messages, &self.live);
        let total = lines.len();

        // Reproduce the scroll computation from `draw` so the indices line up
        // exactly with what is on screen.
        let area_height = self.transcript_height() as usize;
        let max_scroll = total.saturating_sub(area_height);
        let start = max_scroll.saturating_sub(self.scroll_offset).min(total);

        lines.split_off(start)
    }

    /// Render the TUI: scrollable transcript, input box, and status line.
    fn draw(&mut self, config: &ArtermConfig) -> Result<()> {
        let rect = self.terminal.size()?;
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(1),    // transcript
                Constraint::Length(3), // input box (top border + line)
                Constraint::Length(1), // status line
            ])
            .split(rect.into());

        // Build transcript items from committed messages + live text.
        let mut items = Self::build_transcript_items(&self.messages, &self.live);

        // Auto-scroll to bottom unless the user scrolled up.
        let area_height = chunks[0].height as usize;
        let total = items.len();
        let max_scroll = total.saturating_sub(area_height);
        if self.scroll_offset > max_scroll {
            self.scroll_offset = max_scroll;
        }
        let start = max_scroll.saturating_sub(self.scroll_offset).min(total);
        let display_items = items.split_off(start);

        let transcript = List::new(display_items)
            .block(Block::default().borders(Borders::NONE));

        // Input box with a `>` prompt.
        let prompt = if self.agent_busy { "…" } else { ">" };
        let input_box = Paragraph::new(format!("{prompt} {}", self.input)).block(
            Block::default()
                .borders(Borders::TOP)
                .border_style(Style::default().fg(Color::DarkGray)),
        );

        // Status line: Arterm 0.1.0 | provider/model | idle/thinking
        let status = format!(
            " Arterm {} | {}/{} | {}",
            env!("CARGO_PKG_VERSION"),
            config.provider,
            config.model,
            if self.agent_busy { "thinking" } else { "idle" }
        );
        let status_line = Paragraph::new(status).style(Style::default().fg(Color::DarkGray));

        // Capture the selection range (if any) so we can invert the selected
        // cells in the screen buffer after the widgets are rendered.
        let selection_range = self.selection.normalized_range();

        let transcript_area = chunks[0];
        self.terminal.draw(|f| {
            f.render_widget(transcript, transcript_area);
            f.render_widget(input_box, chunks[1]);
            f.render_widget(status_line, chunks[2]);

            // ── Selection highlight ───────────────────────────────────────
            // Invert the colors of every cell inside the selected region. The
            // selection coordinates are in transcript-line space (row, col),
            // which lines up 1:1 with the transcript area's screen cells
            // because the area starts at terminal row 0.
            if let Some(((start_row, start_col), (end_row, end_col))) = selection_range {
                let buf = f.buffer_mut();
                let area_x = transcript_area.x;
                let area_y = transcript_area.y;
                let area_w = transcript_area.width;
                let area_h = transcript_area.height;

                let reverse = Style::default().add_modifier(Modifier::REVERSED);

                let s_row = start_row.min(area_h.saturating_sub(1));
                let e_row = end_row.min(area_h.saturating_sub(1));
                for row in s_row..=e_row {
                    let (lo, hi) = if s_row == e_row {
                        (start_col, end_col)
                    } else if row == s_row {
                        (start_col, area_w)
                    } else if row == e_row {
                        (0, end_col)
                    } else {
                        (0, area_w)
                    };
                    let lo = lo.min(area_w);
                    let hi = hi.min(area_w);
                    for col in lo..hi {
                        let x = area_x + col;
                        let y = area_y + row;
                        if let Some(cell) = buf.cell_mut((x, y)) {
                            cell.set_style(cell.style().patch(reverse));
                        }
                    }
                }
            }
        })?;

        Ok(())
    }

    /// Build the plain-text content of each transcript line, in display order.
    ///
    /// This mirrors [`App::build_transcript_items`] exactly, producing one
    /// `String` per displayed line (including the `USER`/`ASSISTANT`/`TOOL`
    /// prefixes) so mouse selection can index into them.
    fn build_transcript_text(messages: &[TranscriptEntry], live: &str) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();

        for entry in messages {
            match entry {
                TranscriptEntry::User(text) => {
                    push_text_lines_plain(&mut lines, text, "USER");
                }
                TranscriptEntry::Assistant(text) => {
                    push_assistant_lines_plain(&mut lines, text);
                }
                TranscriptEntry::System(text) => {
                    for line in text.lines() {
                        lines.push(format!("  {line}"));
                    }
                }
                TranscriptEntry::ToolCall { name, args } => {
                    lines.push(format!("TOOL {name} {args}"));
                }
                TranscriptEntry::ToolResult {
                    name,
                    output,
                    is_error: _,
                } => {
                    let summary = output.lines().next().unwrap_or("(no output)");
                    lines.push(format!("  ↳ {name}: {summary}"));
                }
            }
        }

        // Live streaming text (not yet committed as a message).
        if !live.is_empty() {
            push_assistant_lines_plain(&mut lines, live);
        }

        lines
    }

    /// Build ratatui [`ListItem`]s from the transcript entries plus any live
    /// streaming text.
    fn build_transcript_items(
        messages: &[TranscriptEntry],
        live: &str,
    ) -> Vec<ListItem<'static>> {
        let mut items: Vec<ListItem<'static>> = Vec::new();

        for entry in messages {
            match entry {
                TranscriptEntry::User(text) => {
                    push_text_lines(&mut items, text, "USER", Color::Cyan);
                }
                TranscriptEntry::Assistant(text) => {
                    push_assistant_lines(&mut items, text);
                }
                TranscriptEntry::System(text) => {
                    for line in text.lines() {
                        items.push(ListItem::new(Line::from(vec![
                            Span::raw("  ".to_string()),
                            Span::styled(
                                line.to_string(),
                                Style::default().fg(Color::Gray),
                            ),
                        ])));
                    }
                }
                TranscriptEntry::ToolCall { name, args } => {
                    items.push(ListItem::new(Line::from(vec![
                        Span::styled(
                            "TOOL ".to_string(),
                            Style::default()
                                .fg(Color::Yellow)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            name.to_string(),
                            Style::default().fg(Color::Yellow),
                        ),
                        Span::raw(" ".to_string()),
                        Span::styled(
                            args.to_string(),
                            Style::default().fg(Color::DarkGray),
                        ),
                    ])));
                }
                TranscriptEntry::ToolResult {
                    name,
                    output,
                    is_error,
                } => {
                    let color = if *is_error { Color::Red } else { Color::Yellow };
                    let summary = output.lines().next().unwrap_or("(no output)");
                    items.push(ListItem::new(Line::from(vec![
                        Span::styled(
                            "  ↳ ".to_string(),
                            Style::default().fg(Color::DarkGray),
                        ),
                        Span::styled(name.to_string(), Style::default().fg(color)),
                        Span::raw(": ".to_string()),
                        Span::styled(
                            summary.to_string(),
                            Style::default().fg(if *is_error {
                                Color::LightRed
                            } else {
                                Color::DarkGray
                            }),
                        ),
                    ])));
                }
            }
        }

        // Live streaming text (not yet committed as a message).
        if !live.is_empty() {
            push_assistant_lines(&mut items, live);
        }

        items
    }

    /// Restore the terminal to its original state.
    pub fn cleanup(&mut self) -> Result<()> {
        disable_raw_mode()?;
        execute!(
            self.terminal.backend_mut(),
            LeaveAlternateScreen,
            DisableMouseCapture
        )?;
        self.terminal.show_cursor()?;
        Ok(())
    }
}

/// RAII safety net: if [`App::cleanup`] is never called (e.g. early return,
/// panic), the terminal is still restored when `App` is dropped.
impl Drop for App {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            LeaveAlternateScreen,
            DisableMouseCapture
        );
        let _ = self.terminal.show_cursor();
    }
}

// ── Free-function helpers for building transcript lines ──────────────────

/// Push assistant message lines rendered as markdown, with a bold green
/// `ASSISTANT` label on the first line.
fn push_assistant_lines(items: &mut Vec<ListItem<'static>>, text: &str) {
    // Hard-code a wide wrap here so word-wrap adapts to the terminal width at
    // draw time rather than at message-commit time.  ratatui's `List` will
    // truncate horizontally; long lines are still wrapped per the terminal.
    let lines = markdown::render_markdown(text, 100);
    for (i, line) in lines.into_iter().enumerate() {
        if i == 0 {
            let mut spans = vec![Span::styled(
                "ASSISTANT ".to_string(),
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
            )];
            spans.extend(line.spans);
            items.push(ListItem::new(Line::from(spans)));
        } else {
            items.push(ListItem::new(line));
        }
    }
}

/// Push each line of `text` as a [`ListItem`], prefixing the first line with a
/// colored bold `label`. All strings are owned so the returned items are
/// `'static` and don't borrow from the caller.
fn push_text_lines(
    items: &mut Vec<ListItem<'static>>,
    text: &str,
    label: &str,
    color: Color,
) {
    let prefix = format!("{label} ");
    for (i, line) in text.lines().enumerate() {
        let label_span = if i == 0 {
            Span::styled(
                prefix.clone(),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )
        } else {
            Span::raw("  ".to_string()) // indent continuation lines
        };
        items.push(ListItem::new(Line::from(vec![
            label_span,
            Span::raw(line.to_string()),
        ])));
    }
}

/// Push assistant message lines as plain text (no styling), with an
/// `ASSISTANT` label on the first line. Used by [`App::build_transcript_text`]
/// to produce the plain-text representation that mouse selection indexes into.
fn push_assistant_lines_plain(out: &mut Vec<String>, text: &str) {
    let lines = markdown::render_markdown(text, 100);
    for (i, line) in lines.into_iter().enumerate() {
        let plain: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        if i == 0 {
            out.push(format!("ASSISTANT {plain}"));
        } else {
            out.push(plain);
        }
    }
}

/// Push each line of `text` as a plain `String`, prefixing the first line
/// with `label`. Mirrors [`push_text_lines`] for the plain-text transcript.
fn push_text_lines_plain(out: &mut Vec<String>, text: &str, label: &str) {
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            out.push(format!("{label} {line}"));
        } else {
            out.push(format!("  {line}"));
        }
    }
}
