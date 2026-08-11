use anyhow::Result;
use async_trait::async_trait;
use std::path::Path;

use arterm_core::Permission;
use crate::Tool;

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str { "glob" }
    fn description(&self) -> &str { "Find files matching a glob pattern." }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string" },
                "path": { "type": "string", "description": "Base directory (default: cwd)." }
            },
            "required": ["pattern"]
        })
    }
    fn permission(&self) -> Permission { Permission::Read }

    async fn execute(&self, args: serde_json::Value) -> Result<String> {
        let pattern = args["pattern"].as_str().ok_or_else(|| anyhow::anyhow!("missing 'pattern'"))?;
        let base = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        // Simple recursive walk with filename matching.
        let mut matches = Vec::new();
        walk_glob(Path::new(base), pattern, &mut matches);
        Ok(matches.join("\n"))
    }
}

fn walk_glob(dir: &Path, pattern: &str, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; } // skip hidden
            if path.is_dir() {
                walk_glob(&path, pattern, out);
            } else if simple_glob(&name, pattern) {
                out.push(path.to_string_lossy().to_string());
            }
        }
    }
}

fn simple_glob(name: &str, pattern: &str) -> bool {
    // Very basic glob: supports * as wildcard.
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        let mut pos = 0;
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty() { continue; }
            if i == 0 && !name.starts_with(part) { return false; }
            match name[pos..].find(part) {
                Some(p) => pos += p + part.len(),
                None => return false,
            }
        }
        if let Some(last) = parts.last() {
            if !last.is_empty() && !name.ends_with(last) { return false; }
        }
        true
    } else {
        name == pattern
    }
}
