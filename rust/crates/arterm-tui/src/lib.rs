pub mod agent;

use anyhow::Result;
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
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
use std::time::Duration;
use tokio::sync::mpsc;

use arterm_config::ArtermConfig;
use agent::{Agent, AgentEvent};

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
}

impl App {
    /// Initialise the terminal (alternate screen + raw mode + mouse capture).
    pub fn new() -> Result<Self> {
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
            "Arterm {} · {}/{} · Type a message and press Enter. Ctrl+C to quit.",
            env!("CARGO_PKG_VERSION"),
            config.provider,
            config.model
        )));

        // ── Main event loop ────────────────────────────────────────────────
        loop {
            self.draw(config)?;

            // Drain agent events (non-blocking) — update display state.
            while let Ok(ev) = agent_rx.try_recv() {
                self.handle_agent_event(ev);
            }

            // Poll for keyboard events with a 50 ms timeout.
            if event::poll(Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    match key.code {
                        // ── Submit input ────────────────────────────────────
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
                        // ── Ctrl+C → quit ───────────────────────────────────
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            break;
                        }
                        // ── Type characters ─────────────────────────────────
                        KeyCode::Char(c) => {
                            self.input.push(c);
                        }
                        KeyCode::Backspace => {
                            self.input.pop();
                        }
                        // ── Scroll ──────────────────────────────────────────
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
            AgentEvent::Error(e) => {
                self.live.clear();
                self.agent_busy = false;
                self.messages.push(TranscriptEntry::System(format!("Error: {e}")));
                self.scroll_offset = 0;
            }
        }
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

        self.terminal.draw(|f| {
            f.render_widget(transcript, chunks[0]);
            f.render_widget(input_box, chunks[1]);
            f.render_widget(status_line, chunks[2]);
        })?;

        Ok(())
    }

    /// Build ratatui [`ListItem`]s from the transcript entries plus any live
    /// streaming text.
    fn build_transcript_items(messages: &[TranscriptEntry], live: &str) -> Vec<ListItem<'static>> {
        let mut items: Vec<ListItem<'static>> = Vec::new();

        for entry in messages {
            match entry {
                TranscriptEntry::User(text) => {
                    push_text_lines(&mut items, text, "USER", Color::Cyan);
                }
                TranscriptEntry::Assistant(text) => {
                    push_text_lines(&mut items, text, "ASSISTANT", Color::Green);
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
                    let color = if *is_error {
                        Color::Red
                    } else {
                        Color::Yellow
                    };
                    let summary = output.lines().next().unwrap_or("(no output)");
                    items.push(ListItem::new(Line::from(vec![
                        Span::styled("  ↳ ".to_string(), Style::default().fg(Color::DarkGray)),
                        Span::styled(name.to_string(), Style::default().fg(color)),
                        Span::raw(": ".to_string()),
                        Span::styled(
                            summary.to_string(),
                            Style::default()
                                .fg(if *is_error { Color::LightRed } else { Color::DarkGray }),
                        ),
                    ])));
                }
            }
        }

        // Live streaming text (not yet committed as a message).
        if !live.is_empty() {
            push_text_lines(&mut items, live, "ASSISTANT", Color::Green);
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

/// Push each line of `text` as a [`ListItem`], prefixing the first line with a
/// colored bold `label`. All strings are owned so the returned items are
/// `'static` and don't borrow from the caller.
fn push_text_lines(items: &mut Vec<ListItem<'static>>, text: &str, label: &str, color: Color) {
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
        items.push(ListItem::new(Line::from(vec![label_span, Span::raw(line.to_string())])));
    }
    // If the text is non-empty but has no trailing newline, `lines()` already
    // handles it. If the text ends with `\n`, the final empty line is dropped
    // which is fine for display.
}
