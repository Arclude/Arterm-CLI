//! `/jobs` overlay: list, time, and stop background jobs.
//!
//! One modal: running jobs first, then recent finished ones. Each row shows
//! elapsed time. `x` (or Delete) stops the selected running job. `r` refreshes.
//!
//! ```text
//!  Background jobs
//!
//!  ▶ docker compose up     bash     12m 4s   running
//!  ▶ cargo build           bash      3m 1s   running
//!  ✓ prune empties         bash         8s   completed
//!
//!    ↑↓ navigate   x stop   r refresh   a all sessions   esc close
//! ```

use chrono::{DateTime, Utc};
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use crate::protocol::BgTaskSummary;

/// What the caller should do after a key was handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobsPickerOutcome {
    Stay,
    Close,
    /// Run a background-job action ("list" | "cancel").
    Action {
        action: &'static str,
        task_id: Option<String>,
        all_sessions: bool,
    },
}

/// Interactive overlay over the background-task manager.
#[derive(Debug, Clone)]
pub struct JobsPicker {
    rows: Vec<BgTaskSummary>,
    selected: usize,
    all_sessions: bool,
    /// Footer status override (action results / in-flight note).
    status: Option<String>,
}

impl JobsPicker {
    pub fn new(rows: Vec<BgTaskSummary>, all_sessions: bool) -> Self {
        Self {
            rows,
            selected: 0,
            all_sessions,
            status: None,
        }
    }

    pub fn all_sessions(&self) -> bool {
        self.all_sessions
    }

    fn selected_row(&self) -> Option<&BgTaskSummary> {
        self.rows.get(self.selected)
    }

    /// Replace the rows with a fresh snapshot, keeping the selection when possible.
    pub fn set_rows(&mut self, rows: Vec<BgTaskSummary>) {
        self.replace_rows(rows, true);
    }

    /// Same as [`set_rows`], but keep an in-flight ⏳ footer (list-while-cancel).
    pub fn set_rows_keep_hourglass(&mut self, rows: Vec<BgTaskSummary>) {
        self.replace_rows(rows, false);
    }

    fn replace_rows(&mut self, rows: Vec<BgTaskSummary>, clear_hourglass: bool) {
        let selected_id = self.selected_row().map(|row| row.task_id.clone());
        self.rows = rows;
        match selected_id.and_then(|id| self.rows.iter().position(|row| row.task_id == id)) {
            Some(index) => self.selected = index,
            None => self.selected = 0,
        }
        if clear_hourglass && self.status.as_deref().is_some_and(|s| s.starts_with('⏳')) {
            self.status = None;
        }
    }

    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
    }

    /// Handle one key. Returns what the caller should do.
    pub fn handle_key(&mut self, code: KeyCode, _modifiers: KeyModifiers) -> JobsPickerOutcome {
        match code {
            KeyCode::Esc | KeyCode::Char('q') => JobsPickerOutcome::Close,
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                JobsPickerOutcome::Stay
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.selected + 1 < self.rows.len() {
                    self.selected += 1;
                }
                JobsPickerOutcome::Stay
            }
            KeyCode::Char('x') | KeyCode::Delete | KeyCode::Backspace => {
                let Some(row) = self.selected_row() else {
                    return JobsPickerOutcome::Stay;
                };
                if row.status != "running" {
                    self.status = Some("Only running jobs can be stopped.".to_string());
                    return JobsPickerOutcome::Stay;
                }
                let task_id = row.task_id.clone();
                self.status = Some(format!("⏳ stopping {task_id}..."));
                JobsPickerOutcome::Action {
                    action: "cancel",
                    task_id: Some(task_id),
                    all_sessions: self.all_sessions,
                }
            }
            KeyCode::Char('r') => {
                self.status = Some("⏳ refreshing jobs...".to_string());
                JobsPickerOutcome::Action {
                    action: "list",
                    task_id: None,
                    all_sessions: self.all_sessions,
                }
            }
            KeyCode::Char('a') => {
                self.all_sessions = !self.all_sessions;
                self.status = Some(if self.all_sessions {
                    "⏳ listing jobs from every session...".to_string()
                } else {
                    "⏳ listing this session's jobs...".to_string()
                });
                JobsPickerOutcome::Action {
                    action: "list",
                    task_id: None,
                    all_sessions: self.all_sessions,
                }
            }
            _ => JobsPickerOutcome::Stay,
        }
    }

    /// Draw the overlay over the whole frame.
    pub fn render(&self, frame: &mut Frame) {
        let area = centered_rect(frame.area(), 84, 22);
        frame.render_widget(Clear, area);

        let dim = Style::default().fg(arterm_tui_style::theme::dim_color());
        let accent = Style::default().fg(arterm_tui_style::theme::accent_color());
        let title = if self.all_sessions {
            " Background jobs · all sessions "
        } else {
            " Background jobs "
        };
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(dim)
            .title(Span::styled(title, accent));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let mut lines: Vec<Line> = Vec::new();
        if self.rows.is_empty() {
            lines.push(Line::from(Span::styled(
                "  No background jobs.",
                dim,
            )));
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "  Agent bash/build/docker jobs started with run_in_background appear here.",
                dim,
            )));
        } else {
            let body_height = inner.height.saturating_sub(3) as usize;
            let start = self
                .selected
                .saturating_sub(body_height.saturating_sub(1) / 2)
                .min(self.rows.len().saturating_sub(body_height));
            for (offset, row) in self.rows.iter().enumerate().skip(start).take(body_height) {
                lines.push(job_line(row, offset == self.selected, inner.width as usize));
            }
        }

        lines.push(Line::from(""));
        let footer = self.status.clone().unwrap_or_else(|| {
            "↑↓ navigate   x stop   r refresh   a all sessions   esc close".to_string()
        });
        lines.push(Line::from(Span::styled(format!("  {footer}"), dim)));

        frame.render_widget(Paragraph::new(lines), inner);
    }
}

fn job_line(row: &BgTaskSummary, selected: bool, width: usize) -> Line<'static> {
    let (glyph, color) = match row.status.as_str() {
        "running" => ("▶", arterm_tui_style::theme::accent_color()),
        "completed" => ("✓", ratatui::style::Color::Rgb(100, 200, 100)),
        "failed" => ("✗", ratatui::style::Color::Rgb(255, 100, 100)),
        "superseded" => ("■", arterm_tui_style::theme::dim_color()),
        _ => ("·", arterm_tui_style::theme::dim_color()),
    };
    let label = row
        .display_name
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(row.tool_name.as_str());
    let elapsed = format_elapsed(row);
    let progress = row
        .progress
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| format!("  {p}"))
        .unwrap_or_default();
    let mut text = format!(
        " {glyph} {label:<28} {tool:<8} {elapsed:>8}  {status}{progress}",
        tool = row.tool_name,
        status = row.status,
    );
    if width > 4 {
        text.truncate(width.saturating_sub(2));
    }
    let mut style = Style::default().fg(color);
    if selected {
        style = style.add_modifier(Modifier::REVERSED);
    }
    Line::from(Span::styled(text, style))
}

fn format_elapsed(row: &BgTaskSummary) -> String {
    if let Some(secs) = row.duration_secs {
        return human_duration(secs);
    }
    if row.status == "running"
        && let Ok(started) = DateTime::parse_from_rfc3339(&row.started_at)
    {
        let elapsed = (Utc::now() - started.with_timezone(&Utc))
            .to_std()
            .unwrap_or_default()
            .as_secs_f64();
        return human_duration(elapsed);
    }
    "-".to_string()
}

fn human_duration(secs: f64) -> String {
    if !secs.is_finite() || secs < 0.0 {
        return "-".to_string();
    }
    let total = secs.round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
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
    use ratatui::{Terminal, backend::TestBackend};

    fn running(id: &str, name: &str) -> BgTaskSummary {
        BgTaskSummary {
            task_id: id.to_string(),
            tool_name: "bash".to_string(),
            display_name: Some(name.to_string()),
            session_id: "session_one".to_string(),
            status: "running".to_string(),
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
            duration_secs: None,
            pid: Some(7),
            detached: true,
            progress: None,
            error: None,
        }
    }

    fn finished(id: &str) -> BgTaskSummary {
        BgTaskSummary {
            task_id: id.to_string(),
            tool_name: "bash".to_string(),
            display_name: Some("cargo test".to_string()),
            session_id: "session_one".to_string(),
            status: "completed".to_string(),
            started_at: "2026-08-27T09:00:00+00:00".to_string(),
            completed_at: Some("2026-08-27T09:00:08+00:00".to_string()),
            duration_secs: Some(8.0),
            pid: None,
            detached: false,
            progress: None,
            error: None,
        }
    }

    fn key(picker: &mut JobsPicker, code: KeyCode) -> JobsPickerOutcome {
        picker.handle_key(code, KeyModifiers::empty())
    }

    fn rendered_text(picker: &JobsPicker) -> String {
        let backend = TestBackend::new(90, 24);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| picker.render(frame))
            .expect("draw");
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                text.push_str(buffer[(x, y)].symbol());
            }
            text.push('\n');
        }
        text
    }

    #[test]
    fn x_cancels_the_selected_running_job() {
        let mut picker = JobsPicker::new(vec![running("aaa", "docker compose up")], false);
        assert_eq!(
            key(&mut picker, KeyCode::Char('x')),
            JobsPickerOutcome::Action {
                action: "cancel",
                task_id: Some("aaa".to_string()),
                all_sessions: false,
            }
        );
    }

    #[test]
    fn x_does_not_cancel_a_finished_job() {
        let mut picker = JobsPicker::new(vec![finished("bbb")], false);
        assert_eq!(key(&mut picker, KeyCode::Char('x')), JobsPickerOutcome::Stay);
    }

    #[test]
    fn r_and_a_request_a_fresh_list() {
        let mut picker = JobsPicker::new(vec![running("aaa", "build")], false);
        assert_eq!(
            key(&mut picker, KeyCode::Char('r')),
            JobsPickerOutcome::Action {
                action: "list",
                task_id: None,
                all_sessions: false,
            }
        );
        assert_eq!(
            key(&mut picker, KeyCode::Char('a')),
            JobsPickerOutcome::Action {
                action: "list",
                task_id: None,
                all_sessions: true,
            }
        );
        assert!(picker.all_sessions());
    }

    #[test]
    fn overlay_shows_elapsed_and_empty_state() {
        let picker = JobsPicker::new(vec![finished("bbb")], false);
        let text = rendered_text(&picker);
        assert!(text.contains("cargo test"), "{text}");
        assert!(text.contains("8s"), "{text}");
        assert!(text.contains("completed"), "{text}");

        let empty = JobsPicker::new(Vec::new(), false);
        let text = rendered_text(&empty);
        assert!(text.contains("No background jobs"), "{text}");
    }

    #[test]
    fn esc_closes() {
        let mut picker = JobsPicker::new(Vec::new(), false);
        assert_eq!(key(&mut picker, KeyCode::Esc), JobsPickerOutcome::Close);
    }

    #[test]
    fn human_duration_formats_minutes() {
        assert_eq!(human_duration(8.2), "8s");
        assert_eq!(human_duration(75.0), "1m 15s");
        assert_eq!(human_duration(3661.0), "1h 1m");
    }

    #[test]
    fn set_rows_clears_hourglass_unless_kept() {
        let mut picker = JobsPicker::new(vec![running("aaa", "build")], false);
        picker.set_status("⏳ already stopping a job...");
        picker.set_rows_keep_hourglass(vec![running("aaa", "build")]);
        assert!(
            rendered_text(&picker).contains("already stopping a job"),
            "list-while-cancel must keep the in-flight footer"
        );
        picker.set_rows(vec![running("aaa", "build")]);
        assert!(
            !rendered_text(&picker).contains("already stopping a job"),
            "a completing snapshot must drop the in-flight footer"
        );
    }
}
