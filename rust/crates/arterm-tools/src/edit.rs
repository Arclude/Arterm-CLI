use anyhow::Result;
use async_trait::async_trait;

use arterm_core::Permission;
use crate::Tool;

pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str { "edit" }
    fn description(&self) -> &str {
        "Search-and-replace a unique string in a file. Fails if the string is not found or appears more than once."
    }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to edit." },
                "old_string": { "type": "string", "description": "The exact text to find." },
                "new_string": { "type": "string", "description": "The replacement text." }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }
    fn permission(&self) -> Permission { Permission::Write }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let path = args["path"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'path'"))?;
        let old_string = args["old_string"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'old_string'"))?;
        let new_string = args["new_string"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'new_string'"))?;

        let content = tokio::fs::read_to_string(path).await
            .map_err(|e| anyhow::anyhow!("read {path}: {e}"))?;

        let count = content.matches(old_string).count();
        if count == 0 {
            anyhow::bail!("edit {path}: old_string not found");
        }
        if count > 1 {
            anyhow::bail!("edit {path}: old_string found {count} times; expected exactly one occurrence");
        }

        let new_content = content.replacen(old_string, new_string, 1);
        tokio::fs::write(path, &new_content).await
            .map_err(|e| anyhow::anyhow!("write {path}: {e}"))?;

        Ok(format!("edited {path}: replaced 1 occurrence"))
    }
}
