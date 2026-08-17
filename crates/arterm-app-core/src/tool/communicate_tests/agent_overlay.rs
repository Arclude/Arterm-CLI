// Tests for the custom-agent spawn overlay (`agent` parameter).

use crate::agents::AgentDefinition;

fn input(fields: serde_json::Value) -> CommunicateInput {
    serde_json::from_value(fields).expect("valid CommunicateInput")
}

fn def() -> AgentDefinition {
    AgentDefinition {
        name: "api-reviewer".to_string(),
        description: "Reviews API diffs".to_string(),
        model: Some("claude-api:claude-fable-5".to_string()),
        effort: Some("high".to_string()),
        tools: vec!["bash".to_string(), "read".to_string()],
        color: Some("yellow".to_string()),
        prompt: "You review APIs meticulously.".to_string(),
        source: std::path::PathBuf::from(".arterm/agents/api-reviewer.md"),
    }
}

#[test]
fn overlay_prepends_persona_and_fills_hints() {
    let params = input(json!({
        "action": "spawn",
        "agent": "api-reviewer",
        "prompt": "Review PR #12",
    }));
    let (message, model, effort, label) = params.apply_agent_overlay(&def(), params.spawn_initial_message());

    let message = message.expect("persona must produce a message");
    assert!(
        message.contains("# Agent persona: api-reviewer"),
        "message must lead with the persona header:\n{message}"
    );
    assert!(message.contains("You review APIs meticulously."));
    assert!(message.contains("# Task"));
    assert!(message.contains("Review PR #12"));

    // Unset model/effort are filled from the frontmatter.
    assert_eq!(model.as_deref(), Some("claude-api:claude-fable-5"));
    assert_eq!(effort.as_deref(), Some("high"));
    // Blank label falls back to the agent name.
    assert_eq!(label, "api-reviewer");
}

#[test]
fn overlay_respects_explicit_fields() {
    let params = input(json!({
        "action": "spawn",
        "agent": "api-reviewer",
        "prompt": "task",
        "model": "gpt-5.5",
        "effort": "low",
        "label": "my reviewer",
    }));
    let (message, model, effort, label) = params.apply_agent_overlay(&def(), params.spawn_initial_message());
    assert!(message.unwrap().contains("task"));
    assert_eq!(model.as_deref(), Some("gpt-5.5"));
    assert_eq!(effort.as_deref(), Some("low"));
    assert_eq!(label, "my reviewer");
}

#[test]
fn no_agent_param_means_no_overlay() {
    let params = input(json!({"action": "spawn", "prompt": "plain task", "label": "worker"}));
    assert!(params.resolve_agent_overlay(None).unwrap().is_none());
    let (message, model, effort, _label) =
        params.apply_agent_overlay(&def(), params.spawn_initial_message());
    // (apply_agent_overlay only runs when an agent was resolved; calling it
    // directly here just proves the pure function does not depend on env.)
    assert!(message.is_some());
    assert!(model.is_some());
    assert!(effort.is_some());
}

#[test]
fn unknown_agent_lists_available() {
    let tmp = tempfile::tempdir().unwrap();
    let agents_dir = tmp.path().join(".arterm").join("agents");
    std::fs::create_dir_all(&agents_dir).unwrap();
    std::fs::write(
        agents_dir.join("reviewer.md"),
        "---\nname: reviewer\n---\nYou review things.",
    )
    .unwrap();

    let params = input(json!({"action": "spawn", "agent": "nonexistent"}));
    let err = params
        .resolve_agent_overlay(Some(tmp.path().to_str().unwrap()))
        .unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("unknown agent 'nonexistent'"), "{msg}");
    assert!(msg.contains("available agents: reviewer"), "{msg}");
}

#[test]
fn known_agent_resolves_from_project_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let agents_dir = tmp.path().join(".arterm").join("agents");
    std::fs::create_dir_all(&agents_dir).unwrap();
    std::fs::write(
        agents_dir.join("reviewer.md"),
        "---\nname: reviewer\nmodel: gpt-5.5\n---\nYou review things.",
    )
    .unwrap();

    let params = input(json!({"action": "spawn", "agent": "reviewer"}));
    let resolved = params
        .resolve_agent_overlay(Some(tmp.path().to_str().unwrap()))
        .unwrap()
        .expect("agent must resolve");
    assert_eq!(resolved.name, "reviewer");
    assert_eq!(resolved.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(resolved.prompt, "You review things.");
}
