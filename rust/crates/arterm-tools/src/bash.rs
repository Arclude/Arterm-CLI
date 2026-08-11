use anyhow::Result;
use async_trait::async_trait;

use arterm_core::Permission;
use crate::Tool;

pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str { "bash" }
    fn description(&self) -> &str { "Run a shell command and return stdout+stderr." }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string" }
            },
            "required": ["command"]
        })
    }
    fn permission(&self) -> Permission { Permission::Write }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let command = args["command"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'command'"))?;
        let output = tokio::process::Command::new("sh")
            .args(["-c", command])
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("bash: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = if stderr.is_empty() {
            stdout.to_string()
        } else {
            format!("{stdout}\n{stderr}")
        };
        Ok(combined)
    }
}
