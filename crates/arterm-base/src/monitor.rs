//! Reactive background monitors.
//!
//! A monitor watches a command's stdout/stderr or a WebSocket feed and emits
//! [`crate::bus::MonitorMatched`] when a compiled pattern hits a line. The
//! server bus monitor turns those events into session soft interrupts.

use crate::bus::{Bus, BusEvent, MonitorMatched};
use anyhow::{Result, anyhow};
use regex::Regex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const DEFAULT_COOLDOWN_MS: u64 = 2_000;
const DEFAULT_MAX_MATCHES: u32 = 20;
const MAX_EVENT_BYTES: usize = 4_096;
const MAX_BINARY_PLACEHOLDER: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorKind {
    Command,
    Ws,
}

impl MonitorKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Ws => "ws",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub monitor_id: String,
    pub session_id: String,
    pub kind: MonitorKind,
    pub source: String,
    pub pattern: String,
    pub matches: u32,
    pub max_matches: u32,
    pub status: MonitorStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorStatus {
    Running,
    Stopped,
}

impl MonitorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Clone)]
pub struct CompiledPattern {
    raw: String,
    regex: Option<Regex>,
}

impl CompiledPattern {
    pub fn compile(raw: &str) -> Self {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Self {
                raw: String::new(),
                regex: None,
            };
        }
        match Regex::new(trimmed) {
            Ok(regex) => Self {
                raw: trimmed.to_string(),
                regex: Some(regex),
            },
            Err(_) => Self {
                raw: trimmed.to_string(),
                regex: None,
            },
        }
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn is_empty(&self) -> bool {
        self.raw.is_empty()
    }

    /// Empty pattern matches every line. Invalid regex fail-opens to
    /// case-insensitive substring matching so a typo never silently drops
    /// events.
    pub fn matches(&self, line: &str) -> bool {
        if self.raw.is_empty() {
            return true;
        }
        if let Some(regex) = &self.regex {
            return regex.is_match(line);
        }
        line.to_ascii_lowercase()
            .contains(&self.raw.to_ascii_lowercase())
    }
}

struct RunningMonitor {
    session_id: String,
    kind: MonitorKind,
    source: String,
    pattern: String,
    matches: u32,
    max_matches: u32,
    stop_tx: watch::Sender<bool>,
    handle: JoinHandle<()>,
}

pub struct MonitorManager {
    monitors: Mutex<HashMap<String, RunningMonitor>>,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self {
            monitors: Mutex::new(HashMap::new()),
        }
    }

    fn generate_id() -> String {
        const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let rand_part: String = (0..4)
            .map(|_| {
                let idx = (rand::random::<u8>() as usize) % ALPHABET.len();
                ALPHABET[idx] as char
            })
            .collect();
        format!("mon{rand_part}")
    }

    pub fn start_command(
        &self,
        session_id: &str,
        command: &str,
        working_dir: Option<PathBuf>,
        pattern: CompiledPattern,
        cooldown_ms: u64,
        max_matches: u32,
    ) -> Result<MonitorInfo> {
        if command.trim().is_empty() {
            anyhow::bail!("monitor: `command` is required for action=start");
        }
        let monitor_id = Self::generate_id();
        let (stop_tx, stop_rx) = watch::channel(false);
        let session_owned = session_id.to_string();
        let command_owned = command.to_string();
        let pattern_owned = pattern.clone();
        let monitor_id_owned = monitor_id.clone();
        let handle = tokio::spawn(async move {
            run_command_monitor(
                monitor_id_owned,
                session_owned,
                command_owned,
                working_dir,
                pattern_owned,
                cooldown_ms,
                max_matches,
                stop_rx,
            )
            .await;
        });
        self.insert_running(
            monitor_id.clone(),
            session_id,
            MonitorKind::Command,
            command,
            pattern.raw(),
            max_matches,
            stop_tx,
            handle,
        );
        Ok(MonitorInfo {
            monitor_id,
            session_id: session_id.to_string(),
            kind: MonitorKind::Command,
            source: command.to_string(),
            pattern: pattern.raw().to_string(),
            matches: 0,
            max_matches,
            status: MonitorStatus::Running,
        })
    }

    pub fn start_ws(
        &self,
        session_id: &str,
        url: &str,
        pattern: CompiledPattern,
        cooldown_ms: u64,
        max_matches: u32,
    ) -> Result<MonitorInfo> {
        let url = url.trim();
        if url.is_empty() {
            anyhow::bail!("monitor: `ws` is required when starting a websocket watch");
        }
        if !(url.starts_with("ws://") || url.starts_with("wss://")) {
            anyhow::bail!("monitor: `ws` must start with ws:// or wss://");
        }
        let monitor_id = Self::generate_id();
        let (stop_tx, stop_rx) = watch::channel(false);
        let session_owned = session_id.to_string();
        let url_owned = url.to_string();
        let pattern_owned = pattern.clone();
        let monitor_id_owned = monitor_id.clone();
        let handle = tokio::spawn(async move {
            run_ws_monitor(
                monitor_id_owned,
                session_owned,
                url_owned,
                pattern_owned,
                cooldown_ms,
                max_matches,
                stop_rx,
            )
            .await;
        });
        self.insert_running(
            monitor_id.clone(),
            session_id,
            MonitorKind::Ws,
            url,
            pattern.raw(),
            max_matches,
            stop_tx,
            handle,
        );
        Ok(MonitorInfo {
            monitor_id,
            session_id: session_id.to_string(),
            kind: MonitorKind::Ws,
            source: url.to_string(),
            pattern: pattern.raw().to_string(),
            matches: 0,
            max_matches,
            status: MonitorStatus::Running,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_running(
        &self,
        monitor_id: String,
        session_id: &str,
        kind: MonitorKind,
        source: &str,
        pattern: &str,
        max_matches: u32,
        stop_tx: watch::Sender<bool>,
        handle: JoinHandle<()>,
    ) {
        let mut guards = self
            .monitors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guards.insert(
            monitor_id,
            RunningMonitor {
                session_id: session_id.to_string(),
                kind,
                source: source.to_string(),
                pattern: pattern.to_string(),
                matches: 0,
                max_matches,
                stop_tx,
                handle,
            },
        );
    }

    pub fn record_match(&self, monitor_id: &str) -> Option<u32> {
        let mut guards = self
            .monitors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let monitor = guards.get_mut(monitor_id)?;
        monitor.matches = monitor.matches.saturating_add(1);
        Some(monitor.matches)
    }

    pub fn list(&self, session_id: Option<&str>) -> Vec<MonitorInfo> {
        let guards = self
            .monitors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut infos: Vec<MonitorInfo> = guards
            .iter()
            .filter(|(_, monitor)| session_id.is_none_or(|session| monitor.session_id == session))
            .map(|(id, monitor)| MonitorInfo {
                monitor_id: id.clone(),
                session_id: monitor.session_id.clone(),
                kind: monitor.kind.clone(),
                source: monitor.source.clone(),
                pattern: monitor.pattern.clone(),
                matches: monitor.matches,
                max_matches: monitor.max_matches,
                status: if monitor.handle.is_finished() {
                    MonitorStatus::Stopped
                } else {
                    MonitorStatus::Running
                },
            })
            .collect();
        infos.sort_by(|a, b| a.monitor_id.cmp(&b.monitor_id));
        infos
    }

    pub fn stop(&self, monitor_id: &str) -> Result<MonitorInfo> {
        let mut guards = self
            .monitors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let monitor = guards
            .remove(monitor_id)
            .ok_or_else(|| anyhow!("monitor: unknown monitor_id `{monitor_id}`"))?;
        let _ = monitor.stop_tx.send(true);
        monitor.handle.abort();
        Ok(MonitorInfo {
            monitor_id: monitor_id.to_string(),
            session_id: monitor.session_id,
            kind: monitor.kind,
            source: monitor.source,
            pattern: monitor.pattern,
            matches: monitor.matches,
            max_matches: monitor.max_matches,
            status: MonitorStatus::Stopped,
        })
    }

    pub fn stop_session(&self, session_id: &str) -> usize {
        let ids: Vec<String> = {
            let guards = self
                .monitors
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guards
                .iter()
                .filter(|(_, monitor)| monitor.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        let count = ids.len();
        for id in ids {
            let _ = self.stop(&id);
        }
        count
    }
}

impl Default for MonitorManager {
    fn default() -> Self {
        Self::new()
    }
}

pub fn global() -> &'static MonitorManager {
    static INSTANCE: OnceLock<MonitorManager> = OnceLock::new();
    INSTANCE.get_or_init(MonitorManager::new)
}

pub fn format_monitor_inject(
    monitor_id: &str,
    kind: &str,
    source: &str,
    pattern: &str,
    line: &str,
) -> String {
    format!(
        "Monitor `{monitor_id}` matched.\nkind: {kind}\nsource: {source}\npattern: {pattern}\nline: {line}"
    )
}

fn truncate_event(line: &str) -> String {
    let mut out = String::new();
    for ch in line.chars() {
        if out.len() + ch.len_utf8() > MAX_EVENT_BYTES {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

struct MatchPublish<'a> {
    monitor_id: &'a str,
    session_id: &'a str,
    kind: MonitorKind,
    source: &'a str,
    pattern: &'a CompiledPattern,
    line: &'a str,
}

struct MatchBudget<'a> {
    last_match: &'a mut Option<std::time::Instant>,
    cooldown: std::time::Duration,
    remaining: &'a mut u32,
}

fn publish_if_match(event: MatchPublish<'_>, budget: MatchBudget<'_>) -> bool {
    if *budget.remaining == 0 {
        return false;
    }
    if !event.pattern.matches(event.line) {
        return false;
    }
    let now = std::time::Instant::now();
    if budget
        .last_match
        .is_some_and(|prev| now.duration_since(prev) < budget.cooldown)
    {
        return false;
    }
    *budget.last_match = Some(now);
    *budget.remaining = budget.remaining.saturating_sub(1);
    let count = global().record_match(event.monitor_id).unwrap_or(0);
    let truncated = truncate_event(event.line);
    Bus::global().publish(BusEvent::MonitorMatched(MonitorMatched {
        monitor_id: event.monitor_id.to_string(),
        session_id: event.session_id.to_string(),
        kind: event.kind.as_str().to_string(),
        source: event.source.to_string(),
        pattern: event.pattern.raw().to_string(),
        line: truncated,
        match_count: count,
    }));
    *budget.remaining > 0
}

#[allow(clippy::too_many_arguments)]
async fn run_command_monitor(
    monitor_id: String,
    session_id: String,
    command: String,
    working_dir: Option<PathBuf>,
    pattern: CompiledPattern,
    cooldown_ms: u64,
    max_matches: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut cmd = build_shell_command(&command);
    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    cmd.kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            crate::logging::warn(&format!(
                "monitor {monitor_id} failed to spawn command: {err}"
            ));
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut stdout_lines = stdout.map(|s| BufReader::new(s).lines());
    let mut stderr_lines = stderr.map(|s| BufReader::new(s).lines());
    let mut stdout_done = stdout_lines.is_none();
    let mut stderr_done = stderr_lines.is_none();
    let cooldown = std::time::Duration::from_millis(cooldown_ms);
    let mut last_match = None;
    let mut remaining = max_matches.max(1);

    while !stdout_done || !stderr_done {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            line = async {
                match stdout_lines.as_mut() {
                    Some(reader) => reader.next_line().await,
                    None => std::future::pending().await,
                }
            }, if !stdout_done => {
                match line {
                    Ok(Some(line)) => {
                        if !publish_if_match(
                            MatchPublish {
                                monitor_id: &monitor_id,
                                session_id: &session_id,
                                kind: MonitorKind::Command,
                                source: &command,
                                pattern: &pattern,
                                line: &line,
                            },
                            MatchBudget {
                                last_match: &mut last_match,
                                cooldown,
                                remaining: &mut remaining,
                            },
                        ) && remaining == 0
                        {
                            break;
                        }
                    }
                    _ => stdout_done = true,
                }
            }
            line = async {
                match stderr_lines.as_mut() {
                    Some(reader) => reader.next_line().await,
                    None => std::future::pending().await,
                }
            }, if !stderr_done => {
                match line {
                    Ok(Some(line)) => {
                        if !publish_if_match(
                            MatchPublish {
                                monitor_id: &monitor_id,
                                session_id: &session_id,
                                kind: MonitorKind::Command,
                                source: &command,
                                pattern: &pattern,
                                line: &line,
                            },
                            MatchBudget {
                                last_match: &mut last_match,
                                cooldown,
                                remaining: &mut remaining,
                            },
                        ) && remaining == 0
                        {
                            break;
                        }
                    }
                    _ => stderr_done = true,
                }
            }
        }
    }

    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn run_ws_monitor(
    monitor_id: String,
    session_id: String,
    url: String,
    pattern: CompiledPattern,
    cooldown_ms: u64,
    max_matches: u32,
    mut stop_rx: watch::Receiver<bool>,
) {
    use futures::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let (ws, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(pair) => pair,
        Err(err) => {
            crate::logging::warn(&format!(
                "monitor {monitor_id} failed to connect websocket {url}: {err}"
            ));
            return;
        }
    };
    let (_, mut read) = ws.split();
    let cooldown = std::time::Duration::from_millis(cooldown_ms);
    let mut last_match = None;
    let mut remaining = max_matches.max(1);

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !publish_if_match(
                            MatchPublish {
                                monitor_id: &monitor_id,
                                session_id: &session_id,
                                kind: MonitorKind::Ws,
                                source: &url,
                                pattern: &pattern,
                                line: &text,
                            },
                            MatchBudget {
                                last_match: &mut last_match,
                                cooldown,
                                remaining: &mut remaining,
                            },
                        ) && remaining == 0
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let placeholder = if bytes.len() > MAX_BINARY_PLACEHOLDER {
                            format!("[binary frame, {} bytes, watch ended]", bytes.len())
                        } else {
                            format!("[binary frame, {} bytes]", bytes.len())
                        };
                        let keep_going = publish_if_match(
                            MatchPublish {
                                monitor_id: &monitor_id,
                                session_id: &session_id,
                                kind: MonitorKind::Ws,
                                source: &url,
                                pattern: &pattern,
                                line: &placeholder,
                            },
                            MatchBudget {
                                last_match: &mut last_match,
                                cooldown,
                                remaining: &mut remaining,
                            },
                        );
                        if bytes.len() > MAX_BINARY_PLACEHOLDER || (!keep_going && remaining == 0) {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame
                            .as_ref()
                            .map(|f| u16::from(f.code))
                            .unwrap_or(1000);
                        let close_line = format!("[websocket closed, code {code}]");
                        let _ = publish_if_match(
                            MatchPublish {
                                monitor_id: &monitor_id,
                                session_id: &session_id,
                                kind: MonitorKind::Ws,
                                source: &url,
                                pattern: &pattern,
                                line: &close_line,
                            },
                            MatchBudget {
                                last_match: &mut last_match,
                                cooldown: std::time::Duration::ZERO,
                                remaining: &mut remaining,
                            },
                        );
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        crate::logging::warn(&format!(
                            "monitor {monitor_id} websocket error: {err}"
                        ));
                        break;
                    }
                    None => break,
                }
            }
        }
    }
}

fn build_shell_command(cmd_str: &str) -> TokioCommand {
    #[cfg(windows)]
    {
        let mut cmd = TokioCommand::new("cmd.exe");
        cmd.args(["/D", "/S", "/C"])
            .raw_arg(format!("\"{cmd_str}\""));
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = TokioCommand::new("bash");
        cmd.arg("-c").arg(cmd_str);
        cmd
    }
}

pub fn default_cooldown_ms() -> u64 {
    DEFAULT_COOLDOWN_MS
}

pub fn default_max_matches() -> u32 {
    DEFAULT_MAX_MATCHES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pattern_matches_every_line() {
        let pattern = CompiledPattern::compile("");
        assert!(pattern.matches("error: boom"));
        assert!(pattern.matches(""));
    }

    #[test]
    fn valid_regex_matches_line() {
        let pattern = CompiledPattern::compile(r"ERROR|FATAL");
        assert!(pattern.matches("ERROR: disk full"));
        assert!(!pattern.matches("info: ok"));
    }

    #[test]
    fn invalid_regex_fail_opens_to_substring() {
        let pattern = CompiledPattern::compile("(");
        assert!(pattern.matches("value (nested)"));
        assert!(pattern.matches("VALUE (NESTED)"));
        assert!(!pattern.matches("no paren"));
    }

    #[test]
    fn format_monitor_inject_includes_ids() {
        let text =
            format_monitor_inject("monab12", "command", "tail -f log", "ERROR", "ERROR boom");
        assert!(text.contains("`monab12`"));
        assert!(text.contains("kind: command"));
        assert!(text.contains("line: ERROR boom"));
    }
}
