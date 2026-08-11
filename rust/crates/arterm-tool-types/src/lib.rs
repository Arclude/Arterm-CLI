//! What a tool produced, and what a tool is called.
//!
//! Both live below the tool subsystem so that lower layers — config, the
//! provider adapters, the permission ladder — can normalize a tool name or read
//! a result without depending on the registry that owns the implementations.

use serde::{Deserialize, Serialize};

/// The result of one tool execution.
///
/// `output` is the only field the model sees. The rest is for the UI and the
/// ledger: `title` names the call in the transcript, `metadata` carries
/// structured detail, and `images` are attached to the conversation as image
/// blocks rather than pasted into the text.
#[derive(Debug, Clone, Default)]
pub struct ToolOutput {
    pub output: String,
    pub title: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub images: Vec<ToolImage>,
    /// Path this call wrote, as declared by the tool itself. Read by the
    /// evidence ledger; a model composing a summary cannot write it.
    pub path: Option<String>,
    /// Unified diff of the write. Deliberately never sent to the model — it
    /// exists so a verifier can check a claim against what actually changed.
    pub diff: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolImage {
    pub media_type: String,
    pub data: String,
    pub label: Option<String>,
}

impl ToolOutput {
    pub fn new(output: impl Into<String>) -> Self {
        Self { output: output.into(), ..Default::default() }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    pub fn with_image(mut self, media_type: impl Into<String>, data: impl Into<String>) -> Self {
        self.images.push(ToolImage {
            media_type: media_type.into(),
            data: data.into(),
            label: None,
        });
        self
    }

    /// Declare the file this call wrote and how it changed. Every mutating tool
    /// must call this: the ledger has no other honest source for it.
    pub fn with_write(mut self, path: impl Into<String>, diff: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self.diff = Some(diff.into());
        self
    }
}

/// What a tool call is allowed to do without asking.
///
/// This is the tool's *declared default*; the permission ladder is what decides
/// an actual call, and an explicit user rule outranks this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPermission {
    /// Read-only. Runs without a prompt.
    Allow,
    /// Writes files or runs commands. Prompts unless the mode says otherwise.
    Ask,
    /// Never runs. Outranks even yolo mode.
    Deny,
}

/// What kind of work a tool does. Drives the auto/plan permission modes.
///
/// This is deliberately NOT the answer to "may it run in parallel" — several
/// `Read` tools still change session state. See `Tool::concurrent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolCategory {
    Read,
    Write,
    Execute,
}

/// Resolve a tool-name alias to its canonical internal name.
///
/// Models emit names in shapes we did not advertise: a transport namespace
/// (`functions.bash`), the PascalCase surface some providers expose (`Read`),
/// or a synonym from their training (`shell_exec`). Resolving centrally means a
/// nested call inside `batch` reaches the same tool a top-level call would.
pub fn resolve_tool_name(name: &str) -> &str {
    // Some function-calling APIs expose a recipient such as `functions.bash`,
    // and models keep that prefix when composing a nested call.
    let name = name.strip_prefix("functions.").unwrap_or(name);

    match name {
        "shell" | "shell_exec" | "Bash" => "bash",
        "read_file" | "file_read" | "Read" => "read",
        "write_file" | "file_write" | "Write" => "write",
        "edit_file" | "file_edit" | "Edit" => "edit",
        "file_grep" | "Grep" => "grep",
        "file_glob" | "Glob" => "glob",
        "todoread" | "todowrite" | "todo_read" | "todo_write" | "todos" => "todo",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_transport_namespace_before_resolving() {
        assert_eq!(resolve_tool_name("functions.bash"), "bash");
        assert_eq!(resolve_tool_name("functions.shell_exec"), "bash");
        assert_eq!(resolve_tool_name("functions.Read"), "read");
    }

    #[test]
    fn leaves_an_unrecognized_namespace_alone() {
        // An MCP tool's name is its own; rewriting it would route the call to
        // the wrong server rather than failing visibly.
        assert_eq!(resolve_tool_name("mcp.functions.bash"), "mcp.functions.bash");
    }

    #[test]
    fn maps_the_pascalcase_surface() {
        assert_eq!(resolve_tool_name("Read"), "read");
        assert_eq!(resolve_tool_name("Write"), "write");
        assert_eq!(resolve_tool_name("Edit"), "edit");
        assert_eq!(resolve_tool_name("Grep"), "grep");
    }

    #[test]
    fn a_write_declares_both_its_path_and_its_diff() {
        // The ledger reads these off the tool, not off the model's summary, so
        // a tool declaring one without the other leaves evidence with a hole.
        let out = ToolOutput::new("wrote").with_write("src/a.rs", "@@ -1 +1 @@");
        assert_eq!(out.path.as_deref(), Some("src/a.rs"));
        assert!(out.diff.is_some());
    }
}
