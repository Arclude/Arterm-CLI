//! The tool contract: what a tool is, and what it is handed when it runs.
//!
//! This crate holds the trait and the context only. The implementations live
//! above it, so adding a tool never recompiles the layers below.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::path::{Path, PathBuf};

use arterm_agent_runtime::InterruptSignal;
use arterm_message_types::ToolDefinition;
use arterm_tool_types::{ToolCategory, ToolOutput, ToolPermission};

/// Why this call is being made, in the model's own words.
///
/// Asked of every tool so the UI can show a reason beside a call instead of raw
/// arguments. It rides on every schema on every request, so the wording is
/// deliberately terse — each word is paid on every iteration of every turn.
pub const TOOL_INTENT_DESCRIPTION: &str =
    "Required short label shown in the UI: why this call is being made.";

/// Input key a caller sets to accept the token cost of an oversized result.
///
/// A result too large for the remaining context is withheld and its cost
/// stated; setting this repeats the call and spends that cost deliberately.
pub const ACCEPT_LARGE_OUTPUT_KEY: &str = "accept_large_output";

pub const ACCEPT_LARGE_OUTPUT_DESCRIPTION: &str =
    "Re-run accepting the stated token cost of a withheld result.";

/// Add the shared `intent` and `accept_large_output` properties to a tool's
/// parameter schema.
///
/// Done centrally rather than per tool: any tool can produce an oversized
/// result, so wiring it by hand would mean editing every schema — and would
/// miss proxied tools, whose schemas come from somewhere else entirely.
pub fn ensure_intent_in_schema(mut schema: Value) -> Value {
    let Some(object) = schema.as_object_mut() else {
        return schema;
    };

    // Only object-shaped parameter schemas have properties to add to.
    let is_object_schema = object
        .get("type")
        .and_then(|t| t.as_str())
        .map(|t| t == "object")
        .unwrap_or_else(|| object.contains_key("properties"));
    if !is_object_schema {
        return schema;
    }

    let properties = object
        .entry("properties")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(properties) = properties.as_object_mut() else {
        return schema;
    };
    // `or_insert_with`, never overwrite: a tool that documents these itself
    // knows something this function does not.
    properties.entry("intent").or_insert_with(|| {
        serde_json::json!({ "type": "string", "description": TOOL_INTENT_DESCRIPTION })
    });
    properties.entry(ACCEPT_LARGE_OUTPUT_KEY).or_insert_with(|| {
        serde_json::json!({ "type": "boolean", "description": ACCEPT_LARGE_OUTPUT_DESCRIPTION })
    });

    match object.get_mut("required") {
        Some(Value::Array(required)) => {
            if !required.iter().any(|v| v.as_str() == Some("intent")) {
                required.push(Value::String("intent".to_string()));
            }
        }
        _ => {
            object.insert(
                "required".to_string(),
                Value::Array(vec![Value::String("intent".to_string())]),
            );
        }
    }
    // Deliberately not required: making it so would ask the model to answer a
    // token-budget question on every single call.

    schema
}

/// What a tool is handed when it runs.
#[derive(Clone)]
pub struct ToolContext {
    pub session_id: String,
    pub message_id: String,
    pub tool_call_id: String,
    /// The session's working directory. Every relative path resolves against
    /// it, and it is the base of the write boundary — never a value the model
    /// supplied, which is the recurring root cause of agent-CLI path escapes.
    pub cwd: PathBuf,
    /// Fires when the user cancels. A long-running tool must observe it.
    pub interrupt: InterruptSignal,
    pub execution_mode: ToolExecutionMode,
}

/// Whether a call came from the model's turn or from a direct invocation
/// (a slash command, a script). Some tools report differently to each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    AgentTurn,
    Direct,
}

impl ToolContext {
    /// A context for a call this tool dispatches itself, keeping the session
    /// and cancel but taking its own call id.
    pub fn for_subcall(&self, tool_call_id: String) -> Self {
        Self { tool_call_id, ..self.clone() }
    }

    /// Resolve a path against the session's working directory.
    ///
    /// Resolution only — this does NOT confine. A tool taking a path from model
    /// output must additionally check the result against its write roots.
    pub fn resolve_path(&self, path: &Path) -> PathBuf {
        if path.is_absolute() { path.to_path_buf() } else { self.cwd.join(path) }
    }
}

/// A tool the agent can call.
#[async_trait]
pub trait Tool: Send + Sync {
    /// The canonical name. Must match what is advertised to the provider.
    fn name(&self) -> &str;

    /// Shown to the model. Sent on every request of every turn, so length here
    /// is a recurring cost, not a one-off.
    fn description(&self) -> &str;

    /// JSON Schema for the arguments.
    fn parameters_schema(&self) -> Value;

    /// The tool's declared default. The permission ladder decides actual calls.
    fn permission(&self) -> ToolPermission;

    /// What kind of work this does. Drives the auto/plan modes — it is not the
    /// concurrency question, see [`Tool::concurrent`].
    fn category(&self) -> ToolCategory;

    /// May this run at the same time as its siblings?
    ///
    /// Absent means NO, deliberately. The bar is not "does not write files" but
    /// "its result cannot depend on whether it ran before or after its
    /// siblings" — `git status` is read-only and still fails it, because it
    /// takes the index lock.
    fn concurrent(&self) -> bool {
        false
    }

    /// One line describing what this specific call would do, for the permission
    /// prompt. A prompt showing raw JSON asks the user to parse arguments.
    fn preview(&self, _input: &Value) -> Option<String> {
        None
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput>;

    /// What the provider is told about this tool.
    fn to_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: self.description().to_string(),
            input_schema: ensure_intent_in_schema(self.parameters_schema()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_is_added_and_required() {
        let schema = serde_json::json!({
            "type": "object",
            "required": ["command"],
            "properties": { "command": { "type": "string" } }
        });
        let out = ensure_intent_in_schema(schema);
        assert!(out["properties"]["intent"].is_object());
        let required: Vec<&str> =
            out["required"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(required.contains(&"command"), "the tool's own requirement survives");
        assert!(required.contains(&"intent"));
    }

    #[test]
    fn the_escape_hatch_is_offered_but_never_required() {
        let out = ensure_intent_in_schema(serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string" } }
        }));
        assert_eq!(out["properties"][ACCEPT_LARGE_OUTPUT_KEY]["type"], "boolean");
        let required: Vec<&str> =
            out["required"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
        assert!(!required.contains(&ACCEPT_LARGE_OUTPUT_KEY));
    }

    #[test]
    fn a_schema_that_documents_these_itself_survives_injection() {
        let out = ensure_intent_in_schema(serde_json::json!({
            "type": "object",
            "properties": { "intent": { "type": "string", "description": "custom" } }
        }));
        assert_eq!(out["properties"]["intent"]["description"], "custom");
        // And it is listed exactly once, not twice.
        assert_eq!(
            out["required"].as_array().unwrap().iter().filter(|v| v.as_str() == Some("intent")).count(),
            1
        );
    }

    #[test]
    fn non_object_schemas_are_left_alone() {
        let schema = serde_json::json!({ "type": "string" });
        assert_eq!(ensure_intent_in_schema(schema.clone()), schema);
    }

    #[test]
    fn relative_paths_resolve_against_the_session_cwd_not_the_process_cwd() {
        let ctx = ToolContext {
            session_id: "s".into(),
            message_id: "m".into(),
            tool_call_id: "c".into(),
            cwd: PathBuf::from("/work/project"),
            interrupt: InterruptSignal::new(),
            execution_mode: ToolExecutionMode::AgentTurn,
        };
        assert_eq!(ctx.resolve_path(Path::new("src/a.rs")), PathBuf::from("/work/project/src/a.rs"));
        assert_eq!(ctx.resolve_path(Path::new("/etc/hosts")), PathBuf::from("/etc/hosts"));
    }
}
