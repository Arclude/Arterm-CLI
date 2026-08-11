use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use arterm_core::Permission;

/// A tool the agent can call. Each tool is a struct implementing this trait.
#[async_trait]
pub trait Tool: Send + Sync {
    /// The tool's name (e.g. "read", "write", "bash").
    fn name(&self) -> &str;

    /// A short description for the system prompt.
    fn description(&self) -> &str;

    /// The JSON schema for this tool's arguments.
    fn parameters(&self) -> serde_json::Value;

    /// The permission level this tool requires.
    fn permission(&self) -> Permission;

    /// Execute the tool with the given arguments (already parsed from JSON).
    async fn execute(&self, args: serde_json::Value) -> Result<String>;
}

/// A registry of all available tools.
pub struct ToolRegistry {
    tools: Vec<Box<dyn Tool>>,
}

impl ToolRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    /// Create a registry with the default tool set (read, write, bash, glob, grep).
    pub fn defaults() -> Self {
        let mut reg = Self::new();
        reg.register(Box::new(crate::read::ReadTool));
        reg.register(Box::new(crate::write::WriteTool));
        reg.register(Box::new(crate::edit::EditTool));
        reg.register(Box::new(crate::bash::BashTool));
        reg.register(Box::new(crate::glob::GlobTool));
        reg.register(Box::new(crate::grep::GrepTool));
        reg
    }

    /// Register a tool.
    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.push(tool);
    }

    /// Find a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.iter().find(|t| t.name() == name).map(|t| t.as_ref())
    }

    /// All registered tool names.
    pub fn names(&self) -> Vec<&str> {
        self.tools.iter().map(|t| t.name()).collect()
    }

    /// JSON schemas for all tools, for the system prompt or provider API.
    pub fn schemas(&self) -> Vec<serde_json::Value> {
        self.tools.iter().map(|t| {
            serde_json::json!({
                "name": t.name(),
                "description": t.description(),
                "parameters": t.parameters(),
            })
        }).collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self { Self::new() }
}

pub mod read;
pub mod write;
pub mod edit;
pub mod bash;
pub mod glob;
pub mod grep;
