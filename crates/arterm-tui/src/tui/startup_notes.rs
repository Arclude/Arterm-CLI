//! "Where we left off": the last few sessions in this directory, shown on the
//! startup screen.
//!
//! Launching into an empty prompt loses the thread — the work is all in the
//! session store, but reaching it means opening the picker and reading rows.
//! These notes put the last few lines of that store on the first screen, so the
//! answer to "what was I doing here?" costs no keystrokes.
//!
//! # What a note says
//!
//! Whatever the session store already knows, in order of preference: the
//! session's title when one was generated, otherwise the user's own first
//! prompt. No model is called and nothing new is written — this reads what
//! sessions already carry. That is a deliberate limit: it describes what was
//! *asked*, not what was *achieved*, which the store does not record.
//!
//! Sessions from other directories are irrelevant here and are dropped, as are
//! sessions nobody typed into (a launch that was closed again) and the session
//! being started right now.

use arterm_tui_session_picker::SessionInfo;
use arterm_tui_style::color::rgb;
use arterm_tui_style::theme::dim_color;
use chrono::{DateTime, Utc};
use ratatui::layout::Alignment;
use ratatui::style::Style;
use ratatui::text::{Line, Span};

/// One line on the startup screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupNote {
    /// When the session was last active, for the relative-time prefix.
    pub when: DateTime<Utc>,
    /// The single line of text describing it.
    pub label: String,
}

/// Longest label kept; the renderer truncates further to fit the frame, but a
/// bound here keeps a pasted wall of text out of the struct in the first place.
const MAX_LABEL_CHARS: usize = 120;

/// Pick the notes for `cwd` out of a loaded session list, newest first.
///
/// `current_session_id` is excluded: the session being started has nothing to
/// say about where we left off.
pub fn notes_from_sessions(
    sessions: &[SessionInfo],
    cwd: &str,
    current_session_id: &str,
    limit: usize,
) -> Vec<StartupNote> {
    if limit == 0 {
        return Vec::new();
    }

    let mut candidates: Vec<&SessionInfo> = sessions
        .iter()
        .filter(|session| session.id != current_session_id)
        .filter(|session| session.user_message_count > 0)
        .filter(|session| {
            session
                .working_dir
                .as_deref()
                .is_some_and(|dir| same_directory(dir, cwd))
        })
        .collect();

    candidates.sort_by(|a, b| b.last_message_time.cmp(&a.last_message_time));

    let mut notes: Vec<StartupNote> = Vec::new();
    for session in candidates {
        let Some(label) = label_for(session) else {
            continue;
        };
        // Re-running the same prompt is common; two identical lines would spend
        // the budget saying one thing.
        if notes.iter().any(|note| note.label == label) {
            continue;
        }
        notes.push(StartupNote {
            when: session.last_message_time,
            label,
        });
        if notes.len() >= limit {
            break;
        }
    }
    notes
}

/// The one line that describes a session, or None when it has nothing to say.
///
/// A session with no title of its own is labelled by the picker with its short
/// name — "otter", "koala" — which says nothing about the work. Only a title
/// somebody or something actually wrote beats the user's own first prompt.
fn label_for(session: &SessionInfo) -> Option<String> {
    let title = single_line(&session.title);
    if !title.is_empty() && title != session.short_name {
        return Some(truncate_chars(&title, MAX_LABEL_CHARS));
    }
    let prompt = single_line(session.first_user_prompt.as_deref().unwrap_or_default());
    if prompt.is_empty() {
        return None;
    }
    Some(truncate_chars(&prompt, MAX_LABEL_CHARS))
}

/// Collapse a prompt to one line: a pasted diff or a multi-line question would
/// otherwise take the whole startup screen.
fn single_line(text: &str) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// Whether two recorded working directories are the same place.
///
/// Compared as text after trimming a trailing separator: the session store
/// writes whatever `std::env::current_dir` gave that run, and one of them
/// having a trailing slash should not hide a session from its own project.
fn same_directory(a: &str, b: &str) -> bool {
    normalize_dir(a) == normalize_dir(b)
}

fn normalize_dir(path: &str) -> &str {
    let trimmed = path.trim_end();
    match trimmed.strip_suffix('/') {
        Some("") => "/",
        Some(stripped) => stripped,
        None => trimmed,
    }
}

/// "3m", "2h", "yesterday", "5d" — the age prefix on a note.
///
/// Short by design: the note's text is what matters, and the age only has to
/// separate "this morning" from "last week".
pub fn relative_age(when: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let minutes = now.signed_duration_since(when).num_minutes();
    if minutes < 1 {
        return "just now".to_string();
    }
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    if days == 1 {
        return "yesterday".to_string();
    }
    if days < 30 {
        return format!("{days}d ago");
    }
    let months = days / 30;
    if months < 12 {
        return format!("{months}mo ago");
    }
    format!("{}y ago", months / 12)
}

/// The block as it appears on the startup screen, or nothing when there are no
/// notes.
///
/// Shared by the two screens that can be the first thing a launch shows: the
/// welcome screen (which takes over the message area whenever the transcript is
/// empty and there are starter suggestions) and the plain empty transcript
/// underneath it. Rendering it in one place is what keeps them from drifting.
pub fn render_lines(
    notes: &[StartupNote],
    now: DateTime<Utc>,
    pad: &str,
    align: Alignment,
) -> Vec<Line<'static>> {
    if notes.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![
        Line::from(""),
        Line::from(Span::styled(
            format!("{pad}Where we left off here"),
            Style::default().fg(dim_color()),
        ))
        .alignment(align),
    ];
    for note in notes {
        lines.push(
            Line::from(vec![
                Span::styled(
                    format!("{pad}· {}  ", relative_age(note.when, now)),
                    Style::default().fg(dim_color()),
                ),
                Span::styled(note.label.clone(), Style::default().fg(rgb(200, 200, 200))),
            ])
            .alignment(align),
        );
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use arterm_session_types::{ResumeTarget, SessionStatus};
    use arterm_tui_session_picker::SessionSource;
    use chrono::TimeZone;

    fn at(minutes: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_786_000_000 + minutes * 60, 0).unwrap()
    }

    fn session(id: &str, dir: &str, prompt: &str, when: DateTime<Utc>) -> SessionInfo {
        SessionInfo {
            id: id.to_string(),
            parent_id: None,
            short_name: id.to_string(),
            icon: String::new(),
            title: String::new(),
            message_count: 2,
            user_message_count: 1,
            assistant_message_count: 1,
            created_at: when,
            last_message_time: when,
            last_active_at: Some(when),
            working_dir: Some(dir.to_string()),
            model: None,
            provider_key: None,
            is_canary: false,
            is_debug: false,
            saved: false,
            save_label: None,
            status: SessionStatus::Closed,
            needs_catchup: false,
            estimated_tokens: 0,
            first_user_prompt: Some(prompt.to_string()),
            messages_preview: Vec::new(),
            search_index: String::new(),
            server_name: None,
            server_icon: None,
            source: SessionSource::Arterm,
            resume_target: ResumeTarget::ArtermSession {
                session_id: id.to_string(),
            },
            external_path: None,
        }
    }

    #[test]
    fn notes_are_newest_first_and_limited() {
        let sessions = vec![
            session("a", "/w", "oldest", at(0)),
            session("c", "/w", "newest", at(20)),
            session("b", "/w", "middle", at(10)),
        ];
        let notes = notes_from_sessions(&sessions, "/w", "current", 2);
        let labels: Vec<&str> = notes.iter().map(|n| n.label.as_str()).collect();
        assert_eq!(labels, vec!["newest", "middle"]);
    }

    #[test]
    fn other_directories_are_not_this_project() {
        let sessions = vec![
            session("a", "/elsewhere", "not here", at(20)),
            session("b", "/w", "here", at(10)),
        ];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].label, "here");
    }

    #[test]
    fn a_trailing_separator_does_not_hide_a_session() {
        let sessions = vec![session("a", "/w/project/", "still ours", at(5))];
        let notes = notes_from_sessions(&sessions, "/w/project", "current", 3);
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn the_session_being_started_is_not_a_note() {
        let sessions = vec![
            session("current", "/w", "this launch", at(30)),
            session("older", "/w", "last time", at(10)),
        ];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].label, "last time");
    }

    #[test]
    fn a_session_nobody_typed_into_says_nothing() {
        let mut empty = session("a", "/w", "", at(20));
        empty.user_message_count = 0;
        empty.first_user_prompt = None;
        let sessions = vec![empty, session("b", "/w", "real work", at(10))];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].label, "real work");
    }

    #[test]
    fn a_generated_title_beats_the_raw_prompt() {
        let mut titled = session("a", "/w", "make the thing faster please", at(20));
        titled.title = "Speed up the parser".to_string();
        let notes = notes_from_sessions(&[titled], "/w", "current", 3);
        assert_eq!(notes[0].label, "Speed up the parser");
    }

    /// The picker labels an untitled session with its short name. That is a
    /// name for the session, not a description of the work, so the prompt wins.
    #[test]
    fn the_short_name_placeholder_does_not_beat_the_prompt() {
        let mut untitled = session("a", "/w", "rewrite the release notes", at(20));
        untitled.title = untitled.short_name.clone();
        let notes = notes_from_sessions(&[untitled], "/w", "current", 3);
        assert_eq!(notes[0].label, "rewrite the release notes");
    }

    #[test]
    fn a_repeated_prompt_is_listed_once() {
        let sessions = vec![
            session("a", "/w", "run the tests", at(30)),
            session("b", "/w", "run the tests", at(20)),
            session("c", "/w", "fix the build", at(10)),
        ];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        let labels: Vec<&str> = notes.iter().map(|n| n.label.as_str()).collect();
        assert_eq!(labels, vec!["run the tests", "fix the build"]);
    }

    #[test]
    fn a_multi_line_prompt_becomes_one_line() {
        let sessions = vec![session("a", "/w", "fix this:\n\n  line one\n  line two", at(5))];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        assert_eq!(notes[0].label, "fix this: line one line two");
    }

    #[test]
    fn a_long_prompt_is_cut_with_an_ellipsis() {
        let long = "x".repeat(400);
        let sessions = vec![session("a", "/w", &long, at(5))];
        let notes = notes_from_sessions(&sessions, "/w", "current", 3);
        assert_eq!(notes[0].label.chars().count(), MAX_LABEL_CHARS);
        assert!(notes[0].label.ends_with('…'));
    }

    #[test]
    fn a_zero_limit_disables_the_notes() {
        let sessions = vec![session("a", "/w", "work", at(5))];
        assert!(notes_from_sessions(&sessions, "/w", "current", 0).is_empty());
    }

    #[test]
    fn ages_read_as_a_person_would_say_them() {
        let now = at(0);
        assert_eq!(relative_age(at(0), now), "just now");
        assert_eq!(relative_age(at(-5), now), "5m ago");
        assert_eq!(relative_age(at(-60 * 3), now), "3h ago");
        assert_eq!(relative_age(at(-60 * 24), now), "yesterday");
        assert_eq!(relative_age(at(-60 * 24 * 4), now), "4d ago");
        assert_eq!(relative_age(at(-60 * 24 * 45), now), "1mo ago");
    }
}
