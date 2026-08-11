use anyhow::Result;
use async_trait::async_trait;

use arterm_core::Permission;
use crate::Tool;

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str { "write" }
    fn description(&self) -> &str { "Write content to a file, creating or overwriting it." }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "content": { "type": "string" }
            },
            "required": ["path", "content"]
        })
    }
    fn permission(&self) -> Permission { Permission::Write }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let path = args["path"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'path'"))?;
        let content = args["content"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'content'"))?;
        tokio::fs::write(path, content).await
            .map_err(|e| anyhow::anyhow!("write {path}: {e}"))?;
        Ok(format!("wrote {} bytes to {path}", content.len()))
    }
}
