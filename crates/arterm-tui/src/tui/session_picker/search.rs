//! Search-index construction and query matching for the session picker.
//!
//! Split out of `loading.rs` so the loader stays under the code-size ratchet
//! while keeping all picker search logic in one cohesive module.

use serde_json::value::RawValue;

use super::{PreviewMessage, SEARCH_CONTENT_BUDGET_BYTES, SessionInfo};

#[cfg(test)]
use super::ResumeTarget;
#[cfg(test)]
use std::fs::File;
#[cfg(test)]
use std::io::{BufReader, Read};
#[cfg(test)]
use std::path::{Path, PathBuf};

#[cfg(test)]
const TRANSCRIPT_SEARCH_CHUNK_BYTES: usize = 64 * 1024;

pub(super) const MESSAGE_SEARCH_EXCERPT_BYTES: usize = 8 * 1024;

fn push_with_byte_budget(dst: &mut String, src: &str, budget: &mut usize) {
    if *budget == 0 || src.is_empty() {
        return;
    }

    let mut end = src.len().min(*budget);
    while end > 0 && !src.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return;
    }

    dst.push_str(&src[..end]);
    *budget = budget.saturating_sub(end);
}

pub(super) fn build_search_index(
    id: &str,
    short_name: &str,
    title: &str,
    working_dir: Option<&str>,
    save_label: Option<&str>,
    messages_preview: &[PreviewMessage],
) -> String {
    let mut combined = String::new();
    combined.push_str(title);
    combined.push(' ');
    combined.push_str(short_name);
    combined.push(' ');
    combined.push_str(id);

    if let Some(dir) = working_dir {
        combined.push(' ');
        combined.push_str(dir);
    }

    if let Some(label) = save_label {
        combined.push(' ');
        combined.push_str(label);
    }

    let mut budget = SEARCH_CONTENT_BUDGET_BYTES;
    for msg in messages_preview {
        let content = msg.content.trim();
        if content.is_empty() {
            continue;
        }
        combined.push(' ');
        push_with_byte_budget(&mut combined, content, &mut budget);
        if budget == 0 {
            break;
        }
    }

    combined.to_lowercase()
}

pub(super) fn push_raw_search_excerpt(dst: &mut String, raw: &str, budget: &mut usize) {
    if *budget == 0 || raw.is_empty() {
        return;
    }
    dst.push(' ');
    push_with_byte_budget(dst, raw, budget);
}

pub(super) fn raw_value_search_excerpt(raw: &RawValue, budget: usize) -> Option<String> {
    if budget == 0 {
        return None;
    }
    let raw = raw.get();
    let mut budget = budget.min(MESSAGE_SEARCH_EXCERPT_BYTES);
    let mut excerpt = String::new();
    push_with_byte_budget(&mut excerpt, raw, &mut budget);
    (!excerpt.is_empty()).then_some(excerpt)
}

pub(super) fn raw_value_display_text(raw: &RawValue) -> Option<String> {
    fn collect_text(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::String(text) => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_text(item, out);
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(text);
                }
            }
            _ => {}
        }
    }

    let value: serde_json::Value = serde_json::from_str(raw.get()).ok()?;
    let mut text = String::new();
    collect_text(&value, &mut text);
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
pub(super) fn session_matches_query(session: &SessionInfo, query: &str) -> bool {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    if session.search_index.contains(&normalized) {
        return true;
    }

    session_transcript_contains_query(session, &normalized)
}

/// Fast in-memory matcher for interactive picker filtering.
///
/// Splits the query into whitespace-separated tokens and requires *every* token
/// to appear somewhere in the session's search index (logical AND, order
/// independent). This is far more forgiving than a single contiguous substring
/// match - `api deploy` now matches a session mentioning "deploy ... api" - while
/// staying cheap: it runs on every keystroke and only does N case-insensitive
/// substring scans over an already-lowercased index.
///
/// This intentionally avoids transcript file I/O. Transcript-backed content can
/// still become searchable after preview load because the picker refreshes the
/// session's cached `search_index` from the loaded preview.
pub(super) fn session_matches_picker_query(session: &SessionInfo, query: &str) -> bool {
    let tokens = search_query_tokens(query);
    tokens.is_empty()
        || tokens
            .iter()
            .all(|token| session.search_index.contains(token))
}

/// Split a raw query into normalized (lowercased, whitespace-trimmed) search
/// tokens. Empty/whitespace-only queries yield no tokens (match everything).
pub(super) fn search_query_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|token| token.to_lowercase())
        .collect()
}

#[cfg(test)]
fn session_transcript_contains_query(session: &SessionInfo, query_lower: &str) -> bool {
    transcript_paths_for_session(session)
        .into_iter()
        .any(|path| file_contains_case_insensitive_query(&path, query_lower))
}

#[cfg(test)]
fn transcript_paths_for_session(session: &SessionInfo) -> Vec<PathBuf> {
    match &session.resume_target {
        ResumeTarget::ArtermSession { session_id } => {
            let Ok(sessions_dir) = crate::storage::arterm_dir().map(|dir| dir.join("sessions"))
            else {
                return Vec::new();
            };
            vec![
                sessions_dir.join(format!("{session_id}.json")),
                sessions_dir.join(format!("{session_id}.journal.jsonl")),
            ]
        }
        ResumeTarget::ClaudeCodeSession { session_path, .. }
        | ResumeTarget::CodexSession { session_path, .. }
        | ResumeTarget::PiSession { session_path, .. }
        | ResumeTarget::OpenCodeSession { session_path, .. }
        | ResumeTarget::CursorSession { session_path, .. } => {
            vec![PathBuf::from(session_path)]
        }
    }
}

#[cfg(test)]
fn file_contains_case_insensitive_query(path: &Path, query_lower: &str) -> bool {
    if query_lower.is_empty() {
        return true;
    }
    if !path.exists() {
        return false;
    }

    if query_lower.is_ascii() {
        return file_contains_ascii_case_insensitive(path, query_lower.as_bytes());
    }

    std::fs::read_to_string(path)
        .ok()
        .map(|content| content.to_lowercase().contains(query_lower))
        .unwrap_or(false)
}

#[cfg(test)]
fn file_contains_ascii_case_insensitive(path: &Path, needle_lower: &[u8]) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let overlap = needle_lower.len().saturating_sub(1);
    let mut carry = Vec::with_capacity(overlap);
    let mut buf = vec![0u8; TRANSCRIPT_SEARCH_CHUNK_BYTES];

    loop {
        let read = match reader.read(&mut buf) {
            Ok(0) => return false,
            Ok(read) => read,
            Err(_) => return false,
        };

        let mut window = Vec::with_capacity(carry.len() + read);
        window.extend_from_slice(&carry);
        window.extend_from_slice(&buf[..read]);

        if contains_ascii_case_insensitive_bytes(&window, needle_lower) {
            return true;
        }

        carry.clear();
        let keep = overlap.min(window.len());
        carry.extend_from_slice(&window[window.len() - keep..]);
    }
}

#[cfg(test)]
fn contains_ascii_case_insensitive_bytes(haystack: &[u8], needle_lower: &[u8]) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if needle_lower.len() > haystack.len() {
        return false;
    }

    haystack.windows(needle_lower.len()).any(|window| {
        window
            .iter()
            .zip(needle_lower.iter())
            .all(|(&hay, &needle)| hay.to_ascii_lowercase() == needle)
    })
}

pub(super) fn build_search_index_from_summary(
    id: &str,
    short_name: &str,
    title: &str,
    working_dir: Option<&str>,
    save_label: Option<&str>,
    transcript_search_text: &str,
) -> String {
    let mut combined = String::new();
    combined.push_str(title);
    combined.push(' ');
    combined.push_str(short_name);
    combined.push(' ');
    combined.push_str(id);

    if let Some(dir) = working_dir {
        combined.push(' ');
        combined.push_str(dir);
    }

    if let Some(label) = save_label {
        combined.push(' ');
        combined.push_str(label);
    }

    if !transcript_search_text.is_empty() {
        combined.push(' ');
        combined.push_str(transcript_search_text);
    }

    combined.to_lowercase()
}
