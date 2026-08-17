//! The `undo` tool: restore the most recent file checkpoint.
//!
//! Complements the checkpoint recorder in [`super::checkpoint`]: file-mutating
//! tools (edit, write, multiedit, patch, apply_patch) snapshot before they
//! write; this tool pops the newest snapshot and restores it.

use crate::tool::{Tool, ToolContext, ToolOutput, checkpoint};
use async_trait::async_trait;
use serde_json::{Value, json};

pub struct UndoTool;

impl UndoTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for UndoTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(serde::Deserialize)]
struct UndoInput {
    /// Specific file to undo. When omitted, undoes the most recent
    /// checkpoint of any file in this session.
    #[serde(default)]
    file_path: Option<String>,
}

#[async_trait]
impl Tool for UndoTool {
    fn name(&self) -> &'static str {
        "undo"
    }

    fn description(&self) -> &'static str {
        "Undo the last file edit via its pre-edit snapshot."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Optional: undo the last edit to this file instead of the globally most recent one."
                }
            },
            "required": ["intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> anyhow::Result<ToolOutput> {
        let params: UndoInput = serde_json::from_value(input)?;

        // Restoring writes (or deletes) a file, so it answers to the sandbox
        // boundary like any other write. Judged on the peeked path, before the
        // pop, so a refusal does not consume the checkpoint.
        let target = match params.file_path {
            Some(ref rel) => Some(ctx.resolve_path(std::path::Path::new(rel))),
            None => checkpoint::GLOBAL
                .latest()
                .filter(|cp| cp.session_id == ctx.session_id)
                .map(|cp| cp.file_path),
        };
        if let Some(ref path) = target {
            crate::tool::sandbox_boundary::ensure_writable(&ctx, path)?;
        }

        let cp = target.and_then(|path| checkpoint::GLOBAL.pop_for_session(&ctx.session_id, &path));

        let Some(cp) = cp else {
            return Ok(ToolOutput::new(
                "No checkpoint to undo for this session.".to_string(),
            ));
        };

        let display = cp.file_path.display().to_string();
        checkpoint::restore(&cp)?;

        let what = if cp.pre_content.is_some() {
            "restored pre-edit content"
        } else {
            "removed file created by the last edit"
        };
        Ok(ToolOutput::new(format!("Undid edit: {display} ({what}).")).with_title(display))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::checkpoint::{self, Checkpoint};

    fn ctx() -> ToolContext {
        ToolContext {
            session_id: "undo-test-session".into(),
            message_id: "m".into(),
            tool_call_id: "t".into(),
            working_dir: Some(std::env::temp_dir()),
            stdin_request_tx: None,
            graceful_shutdown_signal: None,
            execution_mode: crate::tool::ToolExecutionMode::Direct,
            sandbox_mode: "full-access".into(),
        }
    }

    #[tokio::test]
    async fn undo_restores_latest_checkpoint() {
        let dir = std::env::temp_dir().join(format!("arterm-undo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("latest.txt");
        std::fs::write(&file, "after edit").unwrap();

        checkpoint::GLOBAL.record(Checkpoint {
            file_path: file.clone(),
            pre_content: Some(b"before edit".to_vec()),
            created_at: 42,
            session_id: "undo-test-session".into(),
        });

        let out = UndoTool::new()
            .execute(
                json!({"intent": "test", "file_path": file.to_str().unwrap()}),
                ctx(),
            )
            .await
            .unwrap();
        assert!(out.output.contains("restored pre-edit content"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before edit");
    }

    #[tokio::test]
    async fn undo_without_checkpoints_reports_cleanly() {
        let out = UndoTool::new()
            .execute(json!({"intent": "test"}), ctx())
            .await
            .unwrap();
        assert!(out.output.contains("No checkpoint"));
    }

    #[tokio::test]
    async fn undo_deletes_file_created_by_edit() {
        let dir = std::env::temp_dir().join(format!("arterm-undo-del-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("new-file.txt");
        std::fs::write(&file, "created").unwrap();

        checkpoint::GLOBAL.record(Checkpoint {
            file_path: file.clone(),
            pre_content: None,
            created_at: 43,
            session_id: "undo-test-session".into(),
        });

        let _ = UndoTool::new()
            .execute(
                json!({"intent": "test", "file_path": file.to_str().unwrap()}),
                ctx(),
            )
            .await
            .unwrap();
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn undo_is_session_scoped() {
        let dir = std::env::temp_dir().join(format!("arterm-undo-scope-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("scoped.txt");
        std::fs::write(&file, "x").unwrap();

        checkpoint::GLOBAL.record(Checkpoint {
            file_path: file.clone(),
            pre_content: Some(b"other session".to_vec()),
            created_at: 44,
            session_id: "a-different-session".into(),
        });

        let out = UndoTool::new()
            .execute(
                json!({"intent": "test", "file_path": file.to_str().unwrap()}),
                ctx(),
            )
            .await
            .unwrap();
        assert!(out.output.contains("No checkpoint"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
    }
}
