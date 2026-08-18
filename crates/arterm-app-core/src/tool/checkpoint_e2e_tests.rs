//! Integration test: edit a file through the edit tool, then undo through
//! the undo tool, and verify the original content comes back.

use crate::tool::{Tool, ToolContext, ToolExecutionMode, edit::EditTool, undo::UndoTool};
use serde_json::json;
use std::path::PathBuf;

fn ctx(session: &str, dir: &PathBuf) -> ToolContext {
    ToolContext {
        session_id: session.into(),
        message_id: "m".into(),
        tool_call_id: "t".into(),
        working_dir: Some(dir.clone()),
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: ToolExecutionMode::Direct,
    }
}

#[tokio::test]
async fn edit_then_undo_restores_original() {
    let dir = std::env::temp_dir().join(format!("arterm-e2e-undo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("e2e.txt");
    std::fs::write(&file, "line one\nline two\n").unwrap();

    // Edit: replace "two" with "TWO"
    let out = EditTool::new()
        .execute(
            json!({
                "intent": "test edit",
                "file_path": file.to_str().unwrap(),
                "old_string": "line two",
                "new_string": "line TWO"
            }),
            ctx("e2e-session", &dir),
        )
        .await
        .expect("edit should succeed");
    assert!(out.output.contains("Edited"), "edit output: {}", out.output);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "line one\nline TWO\n"
    );

    // Undo: restore the pre-edit content
    let out = UndoTool::new()
        .execute(
            json!({
                "intent": "test undo",
                "file_path": file.to_str().unwrap()
            }),
            ctx("e2e-session", &dir),
        )
        .await
        .expect("undo should succeed");
    assert!(
        out.output.contains("restored"),
        "undo output: {}",
        out.output
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "line one\nline two\n"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn write_new_file_then_undo_removes_it() {
    let dir = std::env::temp_dir().join(format!("arterm-e2e-undo-w-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("brand-new.txt");

    let out = crate::tool::write::WriteTool::new()
        .execute(
            json!({
                "intent": "test write",
                "file_path": file.to_str().unwrap(),
                "content": "created by tool"
            }),
            ctx("e2e-session-w", &dir),
        )
        .await
        .expect("write should succeed");
    assert!(
        out.output.contains("Created") || out.output.contains("Wrote"),
        "write output: {}",
        out.output
    );
    assert!(file.exists());

    let out = UndoTool::new()
        .execute(
            json!({
                "intent": "test undo",
                "file_path": file.to_str().unwrap()
            }),
            ctx("e2e-session-w", &dir),
        )
        .await
        .expect("undo should succeed");
    assert!(
        out.output.contains("removed"),
        "undo output: {}",
        out.output
    );
    assert!(!file.exists(), "undo should delete the tool-created file");

    let _ = std::fs::remove_dir_all(&dir);
}
