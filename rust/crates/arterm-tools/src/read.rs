use anyhow::Result;
use async_trait::async_trait;

use arterm_core::Permission;
use crate::Tool;

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str { "read" }
    fn description(&self) -> &str { "Read a file's contents." }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file." }
            },
            "required": ["path"]
        })
    }
    fn permission(&self) -> Permission { Permission::Read }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let path = args["path"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'path'"))?;
        let content = tokio::fs::read_to_string(path).await
            .map_err(|e| anyhow::anyhow!("read {path}: {e}"))?;
        Ok(content)
    }
}
