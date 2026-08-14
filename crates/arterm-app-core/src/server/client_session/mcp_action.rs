//! The /mcp overlay's management actions, run server-side. Moved out of
//! `client_session.rs` whole for size alone; the semantics are unchanged.

use crate::agent::Agent;
use crate::protocol::ServerEvent;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

/// Run an MCP management action requested by the client's /mcp overlay.
///
/// Routed through the session's `mcp` management tool so this stays exactly
/// as capable (and as observable) as the model doing it: tools get
/// (un)registered and the refreshed `McpStatus` event is pushed by the tool.
/// `Done` signals success; the overlay repaints from the status event.
pub(in crate::server) async fn handle_mcp_action(
    id: u64,
    action: &str,
    server: Option<&str>,
    agent: &Arc<Mutex<Agent>>,
    client_event_tx: &mpsc::UnboundedSender<ServerEvent>,
) {
    if !matches!(
        action,
        "connect" | "reconnect" | "disconnect" | "reload" | "tools"
    ) {
        let _ = client_event_tx.send(ServerEvent::Error {
            id,
            message: format!("Unsupported MCP action '{}'.", action),
            retry_after_secs: None,
        });
        return;
    }
    if action != "reload" && server.is_none() {
        let _ = client_event_tx.send(ServerEvent::Error {
            id,
            message: format!("MCP action '{}' requires a server name.", action),
            retry_after_secs: None,
        });
        return;
    }

    // "tools" is a pure read: answer from the registered tool names.
    if action == "tools" {
        // Present by the guard above: only "reload" may omit the name, and an
        // empty default would quietly answer with nobody's tool list.
        let Some(server_name) = server else { return };
        let prefix = format!("mcp__{}__", server_name);
        let mut tools: Vec<String> = {
            let agent_guard = agent.lock().await;
            agent_guard.tool_names().await
        }
        .into_iter()
        .filter_map(|name| name.strip_prefix(&prefix).map(str::to_string))
        .collect();
        tools.sort();
        let _ = client_event_tx.send(ServerEvent::McpToolList {
            server: server_name.to_string(),
            tools,
        });
        let _ = client_event_tx.send(ServerEvent::Done { id });
        return;
    }

    // "reconnect" is disconnect-then-connect; a failed disconnect (e.g. the
    // server was already down) must not stop the connect half.
    let steps: &[&str] = match action {
        "reconnect" => &["disconnect", "connect"],
        other => &[other][..1],
    };
    let mut result = Ok(());
    for (index, step) in steps.iter().enumerate() {
        let mut input = serde_json::json!({ "action": step });
        if let Some(server) = server {
            input["server"] = serde_json::json!(server);
        }
        let step_result = {
            let mut agent_guard = agent.lock().await;
            let step_result = agent_guard.execute_tool("mcp", input).await;
            // Reload swaps the registered tool set wholesale; drop the locked
            // per-turn tool snapshot so the next turn sees the new tools
            // (same as the debug-socket mcp:reload path).
            if *step == "reload" {
                agent_guard.unlock_tools();
            }
            step_result
        };
        let is_last = index + 1 == steps.len();
        if is_last {
            // The mcp tool reports action failures as successful tool calls
            // with a "... failed" title (the model is meant to read the text).
            // The overlay needs a hard signal, so translate those into errors.
            result = match step_result {
                Ok(output)
                    if output
                        .title
                        .as_deref()
                        .is_some_and(|title| title.to_ascii_lowercase().contains("failed")) =>
                {
                    Err(anyhow::anyhow!("{}", output.output.trim()))
                }
                Ok(_) => Ok(()),
                Err(error) => Err(error),
            };
        }
    }

    match result {
        Ok(()) => {
            let _ = client_event_tx.send(ServerEvent::Done { id });
        }
        Err(error) => {
            let _ = client_event_tx.send(ServerEvent::Error {
                id,
                message: format!("MCP {} failed: {:#}", action, error),
                retry_after_secs: None,
            });
        }
    }
}
