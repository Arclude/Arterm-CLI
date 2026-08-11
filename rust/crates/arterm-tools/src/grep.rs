use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

use arterm_core::Permission;
use crate::Tool;

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str { "grep" }
    fn description(&self) -> &str { "Search for a pattern in files under a directory." }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string", "description": "Directory to search (default: cwd)." }
            },
            "required": ["pattern"]
        })
    }
    fn permission(&self) -> Permission { Permission::Read }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let pattern = args["pattern"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'pattern'"))?;
        let base = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let mut matches = Vec::new();
        walk_grep(Path::new(base), pattern, &mut matches);
        if matches.is_empty() {
            Ok("no matches".into())
        } else {
            Ok(matches.join("\n"))
        }
    }
}

fn walk_grep(dir: &Path, pattern: &str, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            if path.is_dir() {
                walk_grep(&path, pattern, out);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                for (i, line) in content.lines().enumerate() {
                    if line.contains(pattern) {
                        out.push(format!("{}:{}: {}", path.display(), i + 1, line));
                    }
                }
            }
        }
    }
}
