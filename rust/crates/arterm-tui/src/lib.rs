pub mod agent;

use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
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

/// The main TUI application loop.
pub struct App {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    messages: Vec<(String, String)>, // (role, text)
    input: String,
    live: String,
    agent_busy: bool,
    scroll_offset: usize,
}

impl App {
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

    /// Run the event loop. Returns when the user quits.
    pub fn run(&mut self, config: &ArtermConfig) -> Result<()> {
        let system = format!(
            "You are Arterm, a terminal AI coding agent. You help with coding, file editing, and system tasks.\nProvider: {} Model: {}",
            config.provider, config.model
        );

        // Build provider + tools
        let provider = arterm_providers::build_provider(
            &config.provider,
            &config.model,
            config.openai_compat_host.as_deref(),
            config.openai_compat_key.as_deref(),
        )?;

        let tools = arterm_tools::ToolRegistry::defaults();

        let mut agent = Agent {
            messages: Vec::new(),
            provider: Arc::from(provider),
            tools,
            system,
        };

        // Welcome banner
        self.messages.push((
            "system".into(),
            format!("Arterm {} · {} · Type a message and press Enter. Ctrl+C twice to quit.", config.provider, config.model),
        ));

        loop {
            self.draw()?;

            // Poll for events with a short timeout so we can drain agent events
            if event::poll(Duration::from_millis(50))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind != KeyEventKind::Press { continue; }
                    match key.code {
                        KeyCode::Enter => {
                            if self.agent_busy { continue; }
                            let input = std::mem::take(&mut self.input);
                            if input.trim().is_empty() { continue; }
                            if input.trim() == "/exit" || input.trim() == "/quit" { break; }
                            self.messages.push(("user".into(), input.clone()));
                            agent.push_user(&input);
                            self.agent_busy = true;
                            self.live.clear();

                            // Run the turn in a task
                            let (etx, mut erx) = mpsc::unbounded_channel();
                            let provider_clone = agent.provider.clone();
                            let messages = agent.messages.clone();
                            let system = agent.system.clone();
                            tokio::spawn(async move {
                                let mut local_agent = Agent {
                                    messages,
                                    provider: provider_clone,
                                    tools: arterm_tools::ToolRegistry::defaults(),
                                    system,
                                };
                                if let Err(e) = local_agent.run_turn(&etx).await {
                                    let _ = etx.send(AgentEvent::Error(e.to_string()));
                                }
                                // Send back the final messages
                                for msg in &local_agent.messages {
                                    // already pushed by user
                                }
                            });

                            // Drain events synchronously (simplified MVP)
                            while let Some(ev) = erx.blocking_recv() {
                                match ev {
                                    AgentEvent::TextDelta(d) => self.live.push_str(&d),
                                    AgentEvent::AssistantMessage(text) => {
                                        self.messages.push(("assistant".into(), text));
                                        self.live.clear();
                                    }
                                    AgentEvent::Error(e) => {
                                        self.messages.push(("system".into(), format!("error: {e}")));
                                    }
                                    _ => {}
                                }
                            }
                            self.agent_busy = false;
                        }
                        KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                            break;
                        }
                        KeyCode::Char(c) => {
                            self.input.push(c);
                        }
                        KeyCode::Backspace => {
                            self.input.pop();
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }

    fn draw(&mut self) -> Result<()> {
        let constraint = if self.input.is_empty() && !self.agent_busy {
            Constraint::Length(3)
        } else {
            Constraint::Length(3)
        };
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), constraint])
            .split(self.terminal.size()?.into());

        // Transcript
        let mut items: Vec<ListItem> = Vec::new();
        for (role, text) in &self.messages {
            let (color, label) = match role.as_str() {
                "user" => (Color::Cyan, "USER"),
                "assistant" => (Color::Green, "ASSISTANT"),
                _ => (Color::Gray, ""),
            };
            for (i, line) in text.lines().enumerate() {
                let prefix = if i == 0 { format!("{label} ") } else { String::new() };
                items.push(ListItem::new(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(color).add_modifier(Modifier::BOLD)),
                    Span::raw(line),
                ])));
            }
        }
        // Live streaming text
        if !self.live.is_empty() {
            for (i, line) in self.live.lines().enumerate() {
                let prefix = if i == 0 { "ASSISTANT ".to_string() } else { String::new() };
                items.push(ListItem::new(Line::from(vec![
                    Span::styled(prefix, Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)),
                    Span::raw(line),
                ])));
            }
        }

        let transcript = List::new(items)
            .block(Block::default().borders(Borders::NONE));
        self.terminal.draw(|f| {
            f.render_widget(transcript, chunks[0]);

            // Input box
            let prompt_label = if self.agent_busy { "thinking…" } else { "›" };
            let input_box = Paragraph::new(format!("{prompt_label} {}", self.input))
                .block(Block::default().borders(Borders::TOP).border_style(Style::default().fg(Color::DarkGray)));
            f.render_widget(input_box, chunks[1]);
        })?;

        Ok(())
    }

    pub fn cleanup(&mut self) -> Result<()> {
        disable_raw_mode()?;
        execute!(self.terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
        self.terminal.show_cursor()?;
        Ok(())
    }
}
