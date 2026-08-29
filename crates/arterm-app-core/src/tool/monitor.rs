//! Watch a command or WebSocket and inject matching lines into the session.

use super::{Tool, ToolContext, ToolOutput};
use anyhow::Result;
use serde_json::Value;

pub struct MonitorTool;

impl MonitorTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MonitorTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, serde::Deserialize)]
struct MonitorInput {
    action: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    ws: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    monitor_id: Option<String>,
    #[serde(default)]
    cooldown_ms: Option<u64>,
    #[serde(default)]
    max_matches: Option<u32>,
}

#[async_trait::async_trait]
impl Tool for MonitorTool {
    fn name(&self) -> &str {
        "monitor"
    }

    fn description(&self) -> &str {
        "Watch a command or WebSocket and inject matching lines."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["start", "list", "stop"],
                    "description": "start a watch, list running watches, or stop one."
                },
                "command": {
                    "type": "string",
                    "description": "Shell command to watch. Mutually exclusive with ws."
                },
                "ws": {
                    "type": "string",
                    "description": "ws:// or wss:// URL. Mutually exclusive with command."
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex or substring. Empty matches every line."
                },
                "monitor_id": {
                    "type": "string",
                    "description": "Watch id for action=stop."
                },
                "cooldown_ms": {
                    "type": "integer",
                    "description": "Min ms between injects. Default 2000."
                },
                "max_matches": {
                    "type": "integer",
                    "description": "Stop after this many injects. Default 20."
                },
                "intent": {
                    "type": "string",
                    "description": "Required short label shown in the UI: why this call is being made."
                }
            },
            "required": ["action", "intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input: MonitorInput = serde_json::from_value(input)
            .map_err(|e| anyhow::anyhow!("invalid monitor input: {e}"))?;
        match input.action.as_str() {
            "start" => start_monitor(input, ctx),
            "list" => Ok(ToolOutput::new(list_monitors(&ctx.session_id))),
            "stop" => stop_monitor(input),
            other => anyhow::bail!("monitor: unknown action `{other}` (start|list|stop)"),
        }
    }
}

fn start_monitor(input: MonitorInput, ctx: ToolContext) -> Result<ToolOutput> {
    let command = input
        .command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ws = input.ws.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if command.is_some() && ws.is_some() {
        anyhow::bail!("monitor: pass either `command` or `ws`, not both");
    }
    let pattern = crate::monitor::CompiledPattern::compile(input.pattern.as_deref().unwrap_or(""));
    let cooldown_ms = input
        .cooldown_ms
        .unwrap_or_else(crate::monitor::default_cooldown_ms);
    let max_matches = input
        .max_matches
        .unwrap_or_else(crate::monitor::default_max_matches)
        .max(1);
    let info = if let Some(url) = ws {
        crate::monitor::global().start_ws(
            &ctx.session_id,
            url,
            pattern,
            cooldown_ms,
            max_matches,
        )?
    } else if let Some(command) = command {
        crate::monitor::global().start_command(
            &ctx.session_id,
            command,
            ctx.working_dir.clone(),
            pattern,
            cooldown_ms,
            max_matches,
        )?
    } else {
        anyhow::bail!("monitor: `command` or `ws` is required for action=start");
    };

    Ok(ToolOutput::new(format!(
        "Monitor started.\n\n\
         Monitor ID: {}\n\
         Kind: {}\n\
         Source: {}\n\
         Pattern: {}\n\
         Cooldown: {}ms\n\
         Max matches: {}\n\n\
         Matching lines are injected into this session. Use action=stop with monitor_id=\"{}\" to cancel.",
        info.monitor_id,
        match info.kind {
            crate::monitor::MonitorKind::Command => "command",
            crate::monitor::MonitorKind::Ws => "ws",
        },
        info.source,
        if info.pattern.is_empty() {
            "(every line)"
        } else {
            info.pattern.as_str()
        },
        cooldown_ms,
        info.max_matches,
        info.monitor_id,
    )))
}

fn list_monitors(session_id: &str) -> String {
    let infos = crate::monitor::global().list(Some(session_id));
    if infos.is_empty() {
        return "No running monitors in this session.".to_string();
    }
    let mut out = String::from("Monitors:\n\n");
    out.push_str(&format!(
        "{:<10} {:<8} {:<8} {:<10} {}\n",
        "ID", "KIND", "STATUS", "MATCHES", "SOURCE"
    ));
    out.push_str(&"-".repeat(72));
    out.push('\n');
    for info in infos {
        out.push_str(&format!(
            "{:<10} {:<8} {:<8} {:>3}/{:<5} {}\n",
            info.monitor_id,
            match info.kind {
                crate::monitor::MonitorKind::Command => "command",
                crate::monitor::MonitorKind::Ws => "ws",
            },
            info.status.as_str(),
            info.matches,
            info.max_matches,
            info.source
        ));
    }
    out
}

fn stop_monitor(input: MonitorInput) -> Result<ToolOutput> {
    let id = input
        .monitor_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("monitor: `monitor_id` is required for action=stop"))?;
    let info = crate::monitor::global().stop(id)?;
    Ok(ToolOutput::new(format!(
        "Monitor `{}` stopped after {} match(es).",
        info.monitor_id, info.matches
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    fn ctx(session_id: &str, working_dir: Option<PathBuf>) -> ToolContext {
        ToolContext {
            session_id: session_id.into(),
            message_id: "test".into(),
            tool_call_id: "test-call".into(),
            working_dir,
            stdin_request_tx: None,
            ask_user_request_tx: None,
            graceful_shutdown_signal: None,
            execution_mode: crate::tool::ToolExecutionMode::Direct,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn start_list_stop_command_watch() {
        let tmp = std::env::temp_dir().join(format!(
            "arterm-monitor-tool-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let session = format!("ses-monitor-{}", std::process::id());
        let tool = MonitorTool::new();
        let started = tool
            .execute(
                serde_json::json!({
                    "action": "start",
                    "command": "printf 'keep\\nERROR boom\\n'",
                    "pattern": "ERROR",
                    "intent": "watch errors"
                }),
                ctx(&session, Some(tmp.clone())),
            )
            .await
            .expect("start");
        assert!(
            started.output.contains("Monitor started."),
            "got: {}",
            started.output
        );
        assert!(started.output.contains("Monitor ID:"));

        let listed = tool
            .execute(
                serde_json::json!({
                    "action": "list",
                    "intent": "list watches"
                }),
                ctx(&session, Some(tmp.clone())),
            )
            .await
            .expect("list");
        assert!(
            listed.output.contains("Monitors:"),
            "got: {}",
            listed.output
        );

        let id = started
            .output
            .lines()
            .find_map(|line| line.strip_prefix("Monitor ID: "))
            .expect("monitor id")
            .trim()
            .to_string();
        let stopped = tool
            .execute(
                serde_json::json!({
                    "action": "stop",
                    "monitor_id": id,
                    "intent": "stop watch"
                }),
                ctx(&session, Some(tmp.clone())),
            )
            .await
            .expect("stop");
        assert!(
            stopped.output.contains("stopped"),
            "got: {}",
            stopped.output
        );

        let listed = tool
            .execute(
                serde_json::json!({
                    "action": "list",
                    "intent": "list after stop"
                }),
                ctx(&session, Some(tmp)),
            )
            .await
            .expect("list after stop");
        assert!(
            listed.output.contains("No running monitors"),
            "got: {}",
            listed.output
        );
    }

    #[tokio::test]
    async fn start_rejects_both_sources() {
        let err = MonitorTool::new()
            .execute(
                serde_json::json!({
                    "action": "start",
                    "command": "echo hi",
                    "ws": "ws://127.0.0.1:1",
                    "intent": "bad start"
                }),
                ctx("ses-both", None),
            )
            .await
            .expect_err("both sources");
        assert!(
            err.to_string().contains("either `command` or `ws`"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn command_match_publishes_bus_event() {
        let tmp = std::env::temp_dir().join(format!(
            "arterm-monitor-match-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let session = format!("ses-match-{}", std::process::id());
        let mut rx = crate::bus::Bus::global().subscribe();
        let started = MonitorTool::new()
            .execute(
                serde_json::json!({
                    "action": "start",
                    "command": "printf 'keep\\nERROR boom\\n'",
                    "pattern": "ERROR",
                    "cooldown_ms": 0,
                    "intent": "emit match"
                }),
                ctx(&session, Some(tmp)),
            )
            .await
            .expect("start");
        let id = started
            .output
            .lines()
            .find_map(|line| line.strip_prefix("Monitor ID: "))
            .expect("monitor id")
            .trim()
            .to_string();

        let matched = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match rx.recv().await {
                    Ok(crate::bus::BusEvent::MonitorMatched(event))
                        if event.session_id == session && event.line.contains("ERROR boom") =>
                    {
                        return event;
                    }
                    Ok(_) => continue,
                    Err(_) => panic!("bus closed before match"),
                }
            }
        })
        .await
        .expect("match event");
        assert_eq!(matched.monitor_id, id);
        assert_eq!(matched.kind, "command");
        assert_eq!(matched.pattern, "ERROR");

        let _ = crate::monitor::global().stop(&id);
    }
}
