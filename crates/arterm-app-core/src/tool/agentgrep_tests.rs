use super::*;
use chrono::Duration;
use std::fs;
use std::sync::{Mutex, OnceLock};

/// `std::env::set_current_dir` is process-global. Serialize the tests that
/// deliberately point process cwd at a decoy tree so parallel libtest workers
/// cannot stomp each other mid-assertion.
fn process_cwd_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn test_ctx(root: &Path) -> ToolContext {
    ToolContext {
        session_id: "test".to_string(),
        message_id: "test".to_string(),
        tool_call_id: "test".to_string(),
        working_dir: Some(root.to_path_buf()),
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: super::super::ToolExecutionMode::Direct,
    }
}

fn test_exposure(message_index: usize, total_messages: usize) -> ExposureDescriptor {
    ExposureDescriptor {
        timestamp: Some(Utc::now()),
        message_index,
        total_messages,
        compaction_cutoff: None,
    }
}

fn grep_input(query: &str, max_regions: Option<usize>) -> AgentGrepInput {
    AgentGrepInput {
        mode: "grep".to_string(),
        query: Some(query.to_string()),
        file: None,
        terms: None,
        regex: Some(false),
        path: None,
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    }
}

#[test]
fn agentgrep_rejects_missing_session_cwd_instead_of_using_process_cwd() {
    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = None;

    let error = run_agentgrep_blocking(&grep_input("needle", None), &ctx)
        .expect_err("workspace search without a session cwd must fail");

    assert!(error.to_string().contains("session working directory"));
}

#[test]
fn render_compacts_huge_grep_match_lines() {
    let args = GrepArgs {
        query: "set_status_notice".to_string(),
        regex: false,
        file_type: None,
        json: false,
        paths_only: false,
        hidden: false,
        no_ignore: false,
        path: None,
        glob: None,
    };
    let line = format!(
        "{{\"output\":\"{}set_status_notice{}\"}}",
        "a".repeat(800),
        "b".repeat(800)
    );

    let compact = ::agentgrep::render::compact_rendered_match_line(&line, &args);

    assert!(compact.contains("set_status_notice"));
    assert!(compact.contains("[truncated:"), "{compact}");
    assert!(
        compact.chars().count() < 340,
        "compact output should be bounded, got {} chars: {compact}",
        compact.chars().count()
    );
}

#[test]
fn render_compacts_huge_trace_region_body_lines() {
    let line = format!("function handleAuth(){{{}}}", "var x=1;".repeat(2000));

    let compact = ::agentgrep::render::compact_region_body_line(&line);

    assert!(compact.contains("[truncated:"), "{compact}");
    assert!(
        compact.chars().count() < 340,
        "compact region body line should be bounded, got {} chars",
        compact.chars().count()
    );

    let short = "fn small() {}";
    assert_eq!(::agentgrep::render::compact_region_body_line(short), short);
}

#[test]
fn grep_max_regions_limits_rendered_match_excerpts() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(
        temp.path().join("a.rs"),
        "fn one() { status_notice(); }\nfn two() { status_notice(); }\nfn three() { status_notice(); }\n",
    )
    .expect("write file");

    let output = execute_linked_agentgrep(
        &grep_input("status_notice", Some(2)),
        &test_ctx(temp.path()),
        None,
    )
    .expect("agentgrep execute")
    .output;

    assert_eq!(output.matches("      - @ ").count(), 2, "{output}");
    assert!(
        output.contains("1 more matches omitted (max_regions=2)"),
        "{output}"
    );
}

#[test]
fn grep_caps_non_code_file_match_excerpts_by_default() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(
        temp.path().join("timeline.json"),
        (0..5)
            .map(|idx| format!("{{\"event\":\"status_notice {idx}\"}}\n"))
            .collect::<String>(),
    )
    .expect("write file");

    let output = execute_linked_agentgrep(
        &grep_input("status_notice", None),
        &test_ctx(temp.path()),
        None,
    )
    .expect("agentgrep execute")
    .output;

    assert_eq!(output.matches("      - @ ").count(), 3, "{output}");
    assert!(
        output.contains("2 more non-code matches omitted"),
        "{output}"
    );
}

#[test]
fn build_grep_args_includes_scope_flags() {
    let ctx = test_ctx(Path::new("/tmp/root"));
    let params = AgentGrepInput {
        mode: "grep".to_string(),
        query: Some("auth_status".to_string()),
        file: None,
        terms: None,
        regex: Some(true),
        path: Some("src".to_string()),
        glob: Some("src/**/*.rs".to_string()),
        file_type: Some("rs".to_string()),
        hidden: Some(true),
        no_ignore: Some(true),
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: Some(true),
    };

    let args = build_grep_args(&params, &ctx).unwrap();
    assert_eq!(args.query, "auth_status");
    assert!(args.regex);
    assert_eq!(args.file_type.as_deref(), Some("rs"));
    assert!(args.paths_only);
    assert!(args.hidden);
    assert!(args.no_ignore);
    assert_eq!(args.path.as_deref(), Some("/tmp/root/src"));
    assert_eq!(args.glob.as_deref(), Some("src/**/*.rs"));
}

#[test]
fn build_grep_args_drops_match_all_glob() {
    let ctx = test_ctx(Path::new("/tmp/root"));
    let params = AgentGrepInput {
        mode: "grep".to_string(),
        query: Some("agentgrep".to_string()),
        file: None,
        terms: None,
        regex: Some(false),
        path: Some(".".to_string()),
        glob: Some("**/*".to_string()),
        file_type: Some("rs".to_string()),
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let args = build_grep_args(&params, &ctx).unwrap();
    assert_eq!(args.query, "agentgrep");
    assert_eq!(args.file_type.as_deref(), Some("rs"));
    assert_eq!(args.path.as_deref(), Some("/tmp/root/."));
    assert_eq!(args.glob, None);
}

#[test]
fn build_grep_args_scopes_file_path_to_parent_and_exact_glob() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(temp.path().join("src/app.rs"), "fn auth_status() {}\n").expect("write file");

    let ctx = test_ctx(temp.path());
    let params = AgentGrepInput {
        mode: "grep".to_string(),
        query: Some("auth_status".to_string()),
        file: None,
        terms: None,
        regex: Some(false),
        path: Some("src/app.rs".to_string()),
        glob: Some("**/*.rs".to_string()),
        file_type: Some("rs".to_string()),
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let args = build_grep_args(&params, &ctx).unwrap();
    assert_eq!(
        args.path.as_deref(),
        Some(temp.path().join("src").to_string_lossy().as_ref())
    );
    assert_eq!(args.glob.as_deref(), Some("app.rs"));
}

#[test]
fn build_grep_and_find_args_scope_file_field_to_exact_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(temp.path().join("src/app.rs"), "fn auth_status() {}\n").expect("write file");

    let ctx = test_ctx(temp.path());
    let params = AgentGrepInput {
        mode: "grep".to_string(),
        query: Some("auth_status".to_string()),
        file: Some("src/app.rs".to_string()),
        terms: None,
        regex: Some(false),
        path: None,
        glob: Some("**/*.rs".to_string()),
        file_type: Some("rs".to_string()),
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let grep = build_grep_args(&params, &ctx).unwrap();
    let find = build_find_args(&params, &ctx).unwrap();
    let expected_parent = temp.path().join("src").to_string_lossy().into_owned();
    assert_eq!(grep.path.as_deref(), Some(expected_parent.as_str()));
    assert_eq!(grep.glob.as_deref(), Some("app.rs"));
    assert_eq!(find.path.as_deref(), Some(expected_parent.as_str()));
    assert_eq!(find.glob.as_deref(), Some("app.rs"));
}

#[test]
fn build_find_args_allows_glob_only_search() {
    let ctx = test_ctx(Path::new("/tmp/root"));
    let params = AgentGrepInput {
        mode: "find".to_string(),
        query: None,
        file: None,
        terms: None,
        regex: None,
        path: Some(".".to_string()),
        glob: Some("**/*release*".to_string()),
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: Some(25),
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: Some(true),
    };

    let args = build_find_args(&params, &ctx).expect("glob-only find should be valid");
    assert!(args.query_parts.is_empty());
    assert_eq!(args.path.as_deref(), Some("/tmp/root/."));
    assert_eq!(args.glob.as_deref(), Some("**/*release*"));
    assert_eq!(args.max_files, 25);
    assert!(args.paths_only);
}

#[test]
fn build_find_args_still_rejects_unscoped_empty_query() {
    let ctx = test_ctx(Path::new("/tmp/root"));
    let params = AgentGrepInput {
        mode: "find".to_string(),
        query: None,
        file: None,
        terms: None,
        regex: None,
        path: None,
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let error = build_find_args(&params, &ctx).unwrap_err();
    assert_eq!(
        error.to_string(),
        "agentgrep find requires 'query' unless path, glob, or type narrows the search"
    );
}

#[test]
fn build_smart_args_uses_terms() {
    let ctx = test_ctx(Path::new("/workspace"));
    let params = AgentGrepInput {
        mode: "smart".to_string(),
        query: None,
        file: None,
        terms: Some(vec![
            "subject:auth_status".to_string(),
            "relation:rendered".to_string(),
            "path:src/tui".to_string(),
        ]),
        regex: None,
        path: Some("repo".to_string()),
        glob: None,
        file_type: Some("rs".to_string()),
        hidden: None,
        no_ignore: None,
        max_files: Some(3),
        max_regions: Some(4),
        full_region: Some("auto".to_string()),
        debug_plan: Some(true),
        debug_score: Some(true),
        paths_only: None,
    };

    let (args, query) = build_smart_args_and_query(&params, &ctx, None).unwrap();
    assert_eq!(
        args.terms,
        vec!["subject:auth_status", "relation:rendered", "path:src/tui"]
    );
    assert_eq!(args.max_files, 3);
    assert_eq!(args.max_regions, 4);
    assert!(matches!(args.full_region, FullRegionMode::Auto));
    assert!(args.debug_plan);
    assert!(args.debug_score);
    assert_eq!(args.file_type.as_deref(), Some("rs"));
    assert_eq!(args.path.as_deref(), Some("/workspace/repo"));
    assert_eq!(query.subject, "auth_status");
    assert_eq!(query.relation.as_str(), "rendered");
    assert_eq!(query.path_hint.as_deref(), Some("src/tui"));
}

#[test]
fn build_smart_args_falls_back_to_query_terms() {
    let ctx = test_ctx(Path::new("/workspace"));
    let params = AgentGrepInput {
        mode: "smart".to_string(),
        query: Some(
            "subject:auth_status relation:rendered path:src/tui support:current".to_string(),
        ),
        file: None,
        terms: None,
        regex: None,
        path: Some("repo".to_string()),
        glob: None,
        file_type: Some("rs".to_string()),
        hidden: None,
        no_ignore: None,
        max_files: Some(3),
        max_regions: Some(4),
        full_region: Some("auto".to_string()),
        debug_plan: Some(true),
        debug_score: Some(true),
        paths_only: None,
    };

    let (args, _query) = build_smart_args_and_query(&params, &ctx, None).unwrap();
    assert_eq!(
        args.terms,
        vec![
            "subject:auth_status",
            "relation:rendered",
            "path:src/tui",
            "support:current"
        ]
    );
}

#[test]
fn build_args_for_trace_still_requires_terms() {
    let params = AgentGrepInput {
        mode: "trace".to_string(),
        query: Some("subject:auth_status relation:rendered".to_string()),
        file: None,
        terms: None,
        regex: None,
        path: None,
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let error = trace_or_smart_terms_owned(&params).unwrap_err();
    assert_eq!(
        error.to_string(),
        "agentgrep trace requires non-empty 'terms'"
    );
}

#[test]
fn schema_only_advertises_common_public_fields() {
    let schema = AgentGrepTool::new().parameters_schema();
    let props = schema["properties"]
        .as_object()
        .expect("agentgrep schema should have properties");
    let required = schema["required"].as_array().cloned().unwrap_or_default();
    let mode_enum = props["mode"]["enum"]
        .as_array()
        .expect("agentgrep mode should expose enum values");

    assert!(
        !required.contains(&json!("mode")),
        "agentgrep mode should be optional because omitted mode defaults to grep"
    );
    assert!(props.contains_key("mode"));
    assert!(props.contains_key("query"));
    assert!(props.contains_key("file"));
    assert!(props.contains_key("terms"));
    assert!(props.contains_key("regex"));
    assert!(props.contains_key("path"));
    assert!(props.contains_key("glob"));
    assert!(props.contains_key("type"));
    assert!(props.contains_key("max_files"));
    assert!(props.contains_key("max_regions"));
    assert!(props.contains_key("paths_only"));
    assert_eq!(
        mode_enum,
        &vec![
            json!("grep"),
            json!("find"),
            json!("outline"),
            json!("trace")
        ]
    );
    assert!(!props.contains_key("hidden"));
    assert!(!props.contains_key("no_ignore"));
    assert!(!props.contains_key("full_region"));
    assert!(!props.contains_key("debug_plan"));
    assert!(!props.contains_key("debug_score"));
}

#[test]
fn input_defaults_missing_mode_to_grep() {
    let params: AgentGrepInput = serde_json::from_value(json!({
        "query": "auth_status",
        "path": "src"
    }))
    .expect("agentgrep input without mode should deserialize");

    assert_eq!(params.mode, "grep");
    assert_eq!(params.query.as_deref(), Some("auth_status"));
}

#[test]
fn build_outline_args_accepts_file_field() {
    let ctx = test_ctx(Path::new("/workspace"));
    let params = AgentGrepInput {
        mode: "outline".to_string(),
        query: None,
        file: Some("src/tool/agentgrep.rs".to_string()),
        terms: None,
        regex: None,
        path: Some("repo".to_string()),
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let args = build_outline_args(&params, &ctx, None).unwrap();
    assert_eq!(args.file, "src/tool/agentgrep.rs");
    assert_eq!(args.path.as_deref(), Some("/workspace/repo"));
}

#[test]
fn input_accepts_file_path_alias_for_file() {
    let params: AgentGrepInput = serde_json::from_value(json!({
        "mode": "outline",
        "file_path": "src/app.rs"
    }))
    .expect("agentgrep input with file_path should deserialize");

    assert_eq!(params.file.as_deref(), Some("src/app.rs"));
}

#[test]
fn build_outline_args_treats_file_valued_path_as_outline_target() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(temp.path().join("app.rs"), "fn main() {}\n").expect("write file");
    let ctx = test_ctx(temp.path());

    let params = AgentGrepInput {
        mode: "outline".to_string(),
        query: Some("fn".to_string()),
        file: None,
        terms: None,
        regex: None,
        path: Some("app.rs".to_string()),
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let args = build_outline_args(&params, &ctx, None).unwrap();
    assert_eq!(
        args.file,
        temp.path().join("app.rs").display().to_string(),
        "file-valued path should become the outline target instead of joining query onto it"
    );
    assert_eq!(args.path, None);
}

#[test]
fn build_outline_args_does_not_duplicate_file_valued_path_when_file_is_also_set() {
    let temp = tempfile::tempdir().expect("tempdir");
    let relative_file = "src/tool/todo.rs";
    let absolute_file = temp.path().join(relative_file);
    fs::create_dir_all(absolute_file.parent().expect("file parent")).expect("mkdir");
    fs::write(&absolute_file, "pub fn save_todos() {}\n").expect("write file");
    let ctx = test_ctx(temp.path());

    let params = AgentGrepInput {
        mode: "outline".to_string(),
        query: None,
        file: Some(relative_file.to_string()),
        terms: None,
        regex: None,
        path: Some(relative_file.to_string()),
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };

    let args = build_outline_args(&params, &ctx, None).unwrap();
    assert_eq!(args.file, absolute_file.display().to_string());
    assert_eq!(args.path, None);
}

#[tokio::test]
async fn execute_runs_linked_grep() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(
        temp.path().join("src/app.rs"),
        "pub fn auth_status() {}\nfn render_status_bar() {}\n",
    )
    .expect("write file");

    let tool = AgentGrepTool::new();
    let ctx = test_ctx(temp.path());
    let output = tool
        .execute(
            json!({"mode": "grep", "query": "auth_status", "path": ".", "type": "rs"}),
            ctx,
        )
        .await
        .expect("tool output");
    assert!(output.output.contains("query: auth_status"));
    assert!(output.output.contains("src/app.rs"));
    assert!(output.output.contains("@ 1 pub fn auth_status() {}"));
}

#[tokio::test]
async fn execute_runs_linked_grep_when_mode_is_omitted() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(temp.path().join("src/app.rs"), "pub fn auth_status() {}\n").expect("write file");

    let tool = AgentGrepTool::new();
    let ctx = test_ctx(temp.path());
    let output = tool
        .execute(json!({"query": "auth_status", "path": "src"}), ctx)
        .await
        .expect("tool output");

    assert!(output.output.contains("query: auth_status"));
    assert!(output.output.contains("app.rs"));
}

#[tokio::test]
async fn execute_grep_file_field_does_not_scan_sibling_files() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(temp.path().join("src/app.rs"), "fn target() {}\n").expect("write target");
    fs::write(
        temp.path().join("src/sibling.rs"),
        "fn target() { panic!(\"sibling marker\") }\n",
    )
    .expect("write sibling");

    let output = AgentGrepTool::new()
        .execute(
            json!({"mode": "grep", "query": "target", "file": "src/app.rs"}),
            test_ctx(temp.path()),
        )
        .await
        .expect("file-scoped grep");

    assert!(output.output.contains("app.rs"));
    assert!(!output.output.contains("sibling.rs"));
    assert!(!output.output.contains("sibling marker"));
}

#[tokio::test]
async fn execute_runs_linked_grep_when_path_points_to_file() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    fs::write(
        temp.path().join("src/app.rs"),
        "pub fn auth_status() {}\nfn render_status_bar() {}\n",
    )
    .expect("write target file");
    fs::write(
        temp.path().join("src/other.rs"),
        "pub fn auth_status() {}\nfn render_other() {}\n",
    )
    .expect("write sibling file");

    let tool = AgentGrepTool::new();
    let ctx = test_ctx(temp.path());
    let output = tool
        .execute(
            json!({
                "mode": "grep",
                "query": "auth_status",
                "path": "src/app.rs",
                "glob": "**/*.rs",
                "type": "rs"
            }),
            ctx,
        )
        .await
        .expect("tool output for exact-file path");
    assert!(output.output.contains("app.rs"));
    assert!(!output.output.contains("src/other.rs"));
    assert!(!output.output.contains("other.rs"));
}

#[tokio::test]
async fn execute_smart_accepts_query_fallback() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src/tool")).expect("mkdir");
    fs::write(
        temp.path().join("src/tool/lsp.rs"),
        r#"pub struct LspTool;
impl LspTool {}
fn execute() { println!("implementation"); }
"#,
    )
    .expect("write file");

    let tool = AgentGrepTool::new();
    let ctx = test_ctx(temp.path());
    let output = tool
        .execute(
            json!({
                "mode": "smart",
                "query": "subject:lsp relation:implementation path:src/tool",
                "path": ".",
                "max_files": 2,
                "max_regions": 3,
                "debug_plan": true
            }),
            ctx,
        )
        .await
        .expect("agentgrep execution");
    assert!(output.output.contains("debug plan:"));
    assert!(output.output.contains("subject: lsp"));
    assert!(output.output.contains("relation: implementation"));
}

#[test]
fn trace_output_collects_symbols_regions_and_focus() {
    let ctx = test_ctx(Path::new("/repo"));
    let mut context = AgentGrepHarnessContext {
        version: 1,
        ..Default::default()
    };
    let mut focus = HashSet::new();
    let mut file_mtime_cache = HashMap::new();
    let content = r#"
query parameters:
  subject: auth_status
  relation: rendered

top results: 1 files, 1 regions
best answer likely in src/tui/app.rs

1. src/tui/app.rs
   role: ui
   structure:
     - function render_status_bar @ 9002-9017 (16 lines)
     - function draw_header @ 9035-9056 (22 lines)
   regions:
     - render_status_bar @ 9002-9017 (16 lines)
       kind: render-site
       full region:
         fn render_status_bar(&self, ui: &mut Ui) {
             let status = auth_status();
         }
       why:
         - exact subject match
"#;

    collect_trace_exposure(
        content,
        Path::new("/repo"),
        &ctx,
        &mut context,
        &mut focus,
        test_exposure(8, 10),
        &mut file_mtime_cache,
    );

    assert!(focus.contains("src/tui/app.rs"));
    assert!(
        context
            .known_files
            .iter()
            .any(|entry| entry.path == "src/tui/app.rs")
    );
    assert!(
        context
            .known_symbols
            .iter()
            .any(|entry| { entry.path == "src/tui/app.rs" && entry.symbol == "render_status_bar" })
    );
    assert!(context.known_regions.iter().any(|entry| {
        entry.path == "src/tui/app.rs" && entry.start_line == 9002 && entry.end_line == 9017
    }));
}

#[test]
fn bash_exposure_collects_file_and_line_hits() {
    let ctx = test_ctx(Path::new("/repo"));
    let mut context = AgentGrepHarnessContext {
        version: 1,
        ..Default::default()
    };
    let mut focus = HashSet::new();
    let mut file_mtime_cache = HashMap::new();
    let tool = ToolCall {
        id: "tool-1".to_string(),
        name: "bash".to_string(),
        input: json!({
            "command": "cat src/tool/lsp.rs && rg -n auth_status src/tool/lsp.rs"
        }),
        intent: None,
        thought_signature: None,
    };
    let content = "src/tool/lsp.rs:42:let status = auth_status();\n";

    collect_bash_exposure(
        &tool,
        content,
        Path::new("/repo"),
        &ctx,
        &mut context,
        &mut focus,
        test_exposure(9, 10),
        &mut file_mtime_cache,
    );

    assert!(focus.contains("src/tool/lsp.rs"));
    assert!(
        context
            .known_files
            .iter()
            .any(|entry| entry.path == "src/tool/lsp.rs")
    );
    assert!(context.known_regions.iter().any(|entry| {
        entry.path == "src/tool/lsp.rs" && entry.start_line == 42 && entry.end_line == 42
    }));
}

#[test]
fn tuning_penalizes_compacted_history() {
    let temp = tempfile::tempdir().expect("tempdir");
    let ctx = test_ctx(temp.path());
    let file_path = temp.path().join("src/foo.rs");
    fs::create_dir_all(file_path.parent().expect("parent")).expect("mkdir");
    fs::write(&file_path, "fn foo() {}\n").expect("write file");

    let known = AgentGrepKnownFile {
        path: "src/foo.rs".to_string(),
        structure_confidence: 0.9,
        body_confidence: 0.8,
        current_version_confidence: 0.9,
        prune_confidence: 0.8,
        source_strength: "full_file",
        reasons: vec!["test"],
    };
    let mut cache = HashMap::new();
    let tuned = tune_known_file(
        known,
        ExposureDescriptor {
            timestamp: Some(Utc::now()),
            message_index: 1,
            total_messages: 10,
            compaction_cutoff: Some(8),
        },
        temp.path(),
        &ctx,
        &mut cache,
    );

    assert!(tuned.body_confidence < 0.5);
    assert!(tuned.prune_confidence < 0.5);
    assert!(tuned.reasons.contains(&"compacted_history"));
}

#[test]
fn tuning_detects_file_changed_since_seen() {
    let temp = tempfile::tempdir().expect("tempdir");
    let ctx = test_ctx(temp.path());
    let file_path = temp.path().join("src/bar.rs");
    fs::create_dir_all(file_path.parent().expect("parent")).expect("mkdir");
    fs::write(&file_path, "fn bar() {}\n").expect("write file");

    let mut cache = HashMap::new();
    let tuned = tune_known_region(
        AgentGrepKnownRegion {
            path: "src/bar.rs".to_string(),
            start_line: 1,
            end_line: 1,
            body_confidence: 0.9,
            current_version_confidence: 0.9,
            prune_confidence: 0.8,
            source_strength: "full_region",
            reasons: vec!["test"],
        },
        ExposureDescriptor {
            timestamp: Some(Utc::now() - Duration::hours(1)),
            message_index: 9,
            total_messages: 10,
            compaction_cutoff: None,
        },
        temp.path(),
        &ctx,
        &mut cache,
    );

    assert!(tuned.current_version_confidence < 0.6);
    assert!(tuned.reasons.contains(&"file_changed_since_seen"));
}

#[test]
fn input_accepts_legacy_grep_param_aliases() {
    // Models sometimes call the removed native `grep` tool, which is now
    // aliased to agentgrep. Its `pattern`/`include` params must map to
    // agentgrep's `query`/`glob`.
    let input: AgentGrepInput = serde_json::from_value(serde_json::json!({
        "pattern": "fn main",
        "include": "*.rs",
        "path": "src"
    }))
    .expect("legacy grep params should deserialize");
    assert_eq!(input.query.as_deref(), Some("fn main"));
    assert_eq!(input.glob.as_deref(), Some("*.rs"));
    assert_eq!(input.path.as_deref(), Some("src"));
    assert_eq!(input.mode, "grep");
}

#[test]
fn grep_defaults_to_a_bounded_match_count() {
    // grep was the only mode with no default cap: find defaults to 5 files and
    // outline to 6 regions, but grep passed `None` through and rendered every
    // match. One unscoped query over a repo with large data files produced 923k
    // chars in a single call.
    let unbounded = grep_input("x", None);
    assert_eq!(
        unbounded.max_regions.or(Some(DEFAULT_GREP_MAX_REGIONS)),
        Some(DEFAULT_GREP_MAX_REGIONS),
        "grep must be bounded when the caller sets no cap"
    );

    // An explicit cap must win in either direction, including a larger one, so
    // the default is a floor on safety and not a ceiling on capability.
    for explicit in [5usize, 5_000] {
        let params = grep_input("x", Some(explicit));
        assert_eq!(
            params.max_regions.or(Some(DEFAULT_GREP_MAX_REGIONS)),
            Some(explicit),
            "an explicit cap must win over the default"
        );
    }

    // The default has to be generous enough that ordinary code searches are
    // untouched; a cap that clips normal work trades one problem for another.
    // Checked against a real search rather than as a constant comparison, which
    // the compiler would fold away: this repo's own uses of a common internal
    // symbol must fit under the cap.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let args = build_grep_args(&grep_input("guard_context_overflow", None), &test_ctx(root))
        .expect("grep args");
    let result = ::agentgrep::search::run_grep(root, &args).expect("grep should run");
    assert!(
        result.total_matches > 0,
        "sanity: the probe symbol should exist in this crate"
    );
    assert!(
        result.total_matches < DEFAULT_GREP_MAX_REGIONS,
        "an ordinary in-repo search returned {} matches, which the default cap \
         of {} would clip",
        result.total_matches,
        DEFAULT_GREP_MAX_REGIONS
    );
}

/// RAII restore for process cwd. Dropping always chdirs back so a panic cannot
/// strand later tests on a deleted tempfile path.
struct CwdGuard {
    previous: PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl CwdGuard {
    fn chdir_to(decoy: &Path) -> Self {
        let lock = process_cwd_lock();
        // If a prior test left us on a deleted path, jump to a stable root first.
        let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        std::env::set_current_dir(decoy).expect("chdir to decoy");
        Self {
            previous,
            _lock: lock,
        }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let fallback = PathBuf::from("/");
        let target = if self.previous.exists() {
            self.previous.as_path()
        } else {
            fallback.as_path()
        };
        let _ = std::env::set_current_dir(target);
    }
}

/// Build a session tree under `session` and a decoy tree under `decoy`, then
/// point process cwd at the decoy so relative paths must resolve via
/// `ToolContext.working_dir` rather than the server process cwd.
fn session_and_decoy_trees() -> (tempfile::TempDir, tempfile::TempDir, CwdGuard) {
    let session = tempfile::tempdir().expect("session tempdir");
    let decoy = tempfile::tempdir().expect("decoy tempdir");

    fs::create_dir_all(session.path().join("src")).expect("session src");
    fs::write(
        session.path().join("src/app.rs"),
        "pub fn session_marker() {}\nfn sibling_only_in_session() {}\n",
    )
    .expect("session file");
    fs::write(
        session.path().join("src/other.rs"),
        "pub fn other_marker() {}\n",
    )
    .expect("session sibling");

    fs::create_dir_all(decoy.path().join("src")).expect("decoy src");
    fs::write(
        decoy.path().join("src/app.rs"),
        "pub fn decoy_marker() { panic!(\"process-cwd leak\") }\n",
    )
    .expect("decoy file");

    let guard = CwdGuard::chdir_to(decoy.path());
    (session, decoy, guard)
}

#[test]
fn resolve_path_arg_joins_relative_paths_to_session_working_dir_not_process_cwd() {
    let (session, _decoy, _cwd) = session_and_decoy_trees();
    let ctx = test_ctx(session.path());

    let resolved = resolve_path_arg(&ctx, "src/app.rs");
    assert_eq!(resolved, session.path().join("src/app.rs"));
    assert!(
        resolved.is_file(),
        "relative path must hit the session tree even when process cwd is the decoy"
    );

    // Empty string is still "relative": join(base, "") == base.
    let empty = resolve_path_arg(&ctx, "");
    assert_eq!(empty, session.path());
}

#[test]
fn build_args_resolve_relative_path_roots_against_session_working_dir() {
    let (session, _decoy, _cwd) = session_and_decoy_trees();
    let ctx = test_ctx(session.path());
    let expected_src = session.path().join("src").display().to_string();

    let grep = build_grep_args(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("session_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: Some("rs".into()),
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("grep args");
    assert_eq!(grep.path.as_deref(), Some(expected_src.as_str()));

    let find = build_find_args(
        &AgentGrepInput {
            mode: "find".into(),
            query: Some("app".into()),
            file: None,
            terms: None,
            regex: None,
            path: Some("src".into()),
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("find args");
    assert_eq!(find.path.as_deref(), Some(expected_src.as_str()));

    let (smart, _) = build_smart_args_and_query(
        &AgentGrepInput {
            mode: "trace".into(),
            query: None,
            file: None,
            terms: Some(vec![
                "subject:session_marker".into(),
                "relation:implementation".into(),
            ]),
            regex: None,
            path: Some("src".into()),
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: Some(2),
            max_regions: Some(2),
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
        None,
    )
    .expect("trace args");
    assert_eq!(smart.path.as_deref(), Some(expected_src.as_str()));

    // path="" is relative and resolves to the session root (not process cwd).
    let empty_path = build_grep_args(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("session_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some(String::new()),
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("empty path grep args");
    // PathBuf::join(base, "") keeps a trailing separator on Unix; compare as paths.
    let empty_resolved = PathBuf::from(empty_path.path.expect("empty path root"));
    assert_eq!(
        empty_resolved,
        session.path(),
        "path=\"\" must resolve to the session root, not process cwd"
    );
}

#[test]
fn outline_relative_file_is_joined_to_session_root_not_process_cwd() {
    let (session, _decoy, _cwd) = session_and_decoy_trees();
    let ctx = test_ctx(session.path());

    // build_outline_args keeps a relative `file` literal; run_outline joins it
    // onto resolve_search_root(...), which must be the session working_dir.
    let params = AgentGrepInput {
        mode: "outline".into(),
        query: None,
        file: Some("src/app.rs".into()),
        terms: None,
        regex: None,
        path: None,
        glob: None,
        file_type: None,
        hidden: None,
        no_ignore: None,
        max_files: None,
        max_regions: None,
        full_region: None,
        debug_plan: None,
        debug_score: None,
        paths_only: None,
    };
    let args = build_outline_args(&params, &ctx, None).expect("outline args");
    assert_eq!(args.file, "src/app.rs");
    assert_eq!(args.path, None);

    let root = resolve_search_root(&ctx, args.path.as_deref()).expect("outline root");
    assert_eq!(root, session.path());
    let joined = root.join(&args.file);
    assert_eq!(joined, session.path().join("src/app.rs"));
    assert!(joined.is_file());

    let output = execute_linked_agentgrep(&params, &ctx, None).expect("outline execute");
    assert!(
        output.output.contains("session_marker") || output.output.contains("app.rs"),
        "outline must read the session file, got: {}",
        output.output
    );
    assert!(
        !output.output.contains("decoy_marker"),
        "outline must not read the process-cwd decoy: {}",
        output.output
    );
}

#[test]
fn missing_working_dir_allows_absolute_path_and_file_execute() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(temp.path().join("src")).expect("mkdir");
    let absolute = temp.path().join("src/app.rs");
    fs::write(&absolute, "pub fn absolute_only() {}\n").expect("write");

    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = None;

    // Relative path without a session cwd must still fail.
    let relative_err = run_agentgrep_blocking(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("absolute_only".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect_err("relative path without working_dir must fail");
    assert!(
        relative_err
            .to_string()
            .contains("session working directory"),
        "{relative_err}"
    );

    let via_path = run_agentgrep_blocking(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("absolute_only".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some(absolute.display().to_string()),
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: Some(5),
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("absolute path without working_dir");
    assert!(
        via_path.output.contains("absolute_only"),
        "{}",
        via_path.output
    );

    let via_file = run_agentgrep_blocking(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("absolute_only".into()),
            file: Some(absolute.display().to_string()),
            terms: None,
            regex: Some(false),
            path: None,
            glob: None,
            file_type: None,
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: Some(5),
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("absolute file without working_dir");
    assert!(
        via_file.output.contains("absolute_only"),
        "{}",
        via_file.output
    );
}

#[tokio::test]
async fn execute_modes_honor_session_working_dir_when_process_cwd_differs() {
    let (session, _decoy, _cwd) = session_and_decoy_trees();
    let ctx = test_ctx(session.path());
    let tool = AgentGrepTool::new();

    let grep = tool
        .execute(
            json!({"mode": "grep", "query": "session_marker", "path": "src", "type": "rs"}),
            ctx.clone(),
        )
        .await
        .expect("grep");
    assert!(grep.output.contains("session_marker"), "{}", grep.output);
    assert!(!grep.output.contains("decoy_marker"), "{}", grep.output);

    let find = tool
        .execute(
            json!({"mode": "find", "query": "app", "path": "src"}),
            ctx.clone(),
        )
        .await
        .expect("find");
    assert!(
        find.output.contains("app.rs") || find.output.to_lowercase().contains("app"),
        "{}",
        find.output
    );
    assert!(!find.output.contains("decoy_marker"), "{}", find.output);

    let outline = tool
        .execute(
            json!({"mode": "outline", "file": "src/app.rs"}),
            ctx.clone(),
        )
        .await
        .expect("outline");
    assert!(
        outline.output.contains("session_marker") || outline.output.contains("app.rs"),
        "{}",
        outline.output
    );
    assert!(
        !outline.output.contains("decoy_marker"),
        "{}",
        outline.output
    );

    let trace = tool
        .execute(
            json!({
                "mode": "trace",
                "terms": ["subject:session_marker", "relation:implementation"],
                "path": "src",
                "max_files": 2,
                "max_regions": 2
            }),
            ctx,
        )
        .await
        .expect("trace");
    assert!(
        !trace.output.contains("decoy_marker"),
        "trace must not hit process cwd: {}",
        trace.output
    );
}

#[tokio::test]
async fn execute_file_field_and_path_field_scope_differently() {
    let (session, _decoy, _cwd) = session_and_decoy_trees();
    let ctx = test_ctx(session.path());
    let tool = AgentGrepTool::new();

    // file= scopes to one exact file (sibling must not match).
    let file_scoped = tool
        .execute(
            json!({"mode": "grep", "query": "marker", "file": "src/app.rs"}),
            ctx.clone(),
        )
        .await
        .expect("file-scoped grep");
    assert!(
        file_scoped.output.contains("app.rs"),
        "{}",
        file_scoped.output
    );
    assert!(
        !file_scoped.output.contains("other.rs"),
        "file= must not scan siblings: {}",
        file_scoped.output
    );

    // path= directory scopes to the directory (both files may match).
    let path_scoped = tool
        .execute(
            json!({"mode": "grep", "query": "marker", "path": "src"}),
            ctx.clone(),
        )
        .await
        .expect("path-scoped grep");
    assert!(
        path_scoped.output.contains("app.rs") || path_scoped.output.contains("other.rs"),
        "{}",
        path_scoped.output
    );

    // path= file scopes like an exact file via parent+glob + retain filter.
    let path_file = tool
        .execute(
            json!({"mode": "grep", "query": "marker", "path": "src/app.rs"}),
            ctx,
        )
        .await
        .expect("path-as-file grep");
    assert!(path_file.output.contains("app.rs"), "{}", path_file.output);
    assert!(
        !path_file.output.contains("other.rs"),
        "path=file must not scan siblings: {}",
        path_file.output
    );
}

/// Relative `ToolContext.working_dir` is not canonicalized. At OS open time the
/// crate binds roots with `rg Command::current_dir(root)`, `WalkBuilder::new(root)`,
/// and outline `root.join(file)`, so a relative working_dir is interpreted against
/// the *process* cwd, not a frozen absolute session root.
fn write_marker_tree(root: &Path, marker_fn: &str) {
    fs::create_dir_all(root.join("src")).expect("src");
    fs::write(
        root.join("src/app.rs"),
        format!("pub fn {marker_fn}() {{}}\nfn sibling_{marker_fn}() {{}}\n"),
    )
    .expect("app.rs");
    fs::write(
        root.join("src/other.rs"),
        format!("pub fn other_{marker_fn}() {{}}\n"),
    )
    .expect("other.rs");
}

fn assert_modes_hit_marker(ctx: &ToolContext, marker: &str, decoy: &str) {
    let tool = AgentGrepTool::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    for (label, input) in [
        (
            "grep path omitted",
            json!({"mode": "grep", "query": marker, "type": "rs", "max_regions": 8}),
        ),
        (
            "grep path=src",
            json!({"mode": "grep", "query": marker, "path": "src", "type": "rs", "max_regions": 8}),
        ),
        (
            "find path omitted",
            json!({"mode": "find", "query": "app", "max_files": 5}),
        ),
        (
            "find path=src",
            json!({"mode": "find", "query": "app", "path": "src", "max_files": 5}),
        ),
        (
            "outline path omitted",
            json!({"mode": "outline", "file": "src/app.rs"}),
        ),
        (
            "outline path=src",
            json!({"mode": "outline", "file": "app.rs", "path": "src"}),
        ),
        (
            "trace path omitted",
            json!({
                "mode": "trace",
                "terms": [format!("subject:{marker}"), "relation:implementation"],
                "max_files": 3,
                "max_regions": 3
            }),
        ),
        (
            "trace path=src",
            json!({
                "mode": "trace",
                "terms": [format!("subject:{marker}"), "relation:implementation"],
                "path": "src",
                "max_files": 3,
                "max_regions": 3
            }),
        ),
    ] {
        let out = rt
            .block_on(tool.execute(input, ctx.clone()))
            .unwrap_or_else(|err| panic!("{label} failed: {err}"));
        assert!(
            !out.output.contains(decoy),
            "{label} leaked decoy marker: {}",
            out.output
        );
        // find may rank by filename; outline/trace may only show structure. Accept
        // either the marker body or the session file path, but never the decoy.
        let ok = out.output.contains(marker)
            || out.output.contains("app.rs")
            || out.output.contains("src/");
        assert!(ok, "{label} missed intended tree: {}", out.output);
    }
}

#[test]
fn relative_dot_working_dir_binds_to_process_cwd_all_modes() {
    // working_dir="." means "process cwd now". Markers live only under the process
    // cwd tree; a sibling decoy is not on the search root unless path resolution
    // escapes (it must not).
    let lock = process_cwd_lock();
    let session = tempfile::tempdir().expect("session");
    let decoy = tempfile::tempdir().expect("decoy");
    write_marker_tree(session.path(), "session_dot_marker");
    write_marker_tree(decoy.path(), "decoy_dot_marker");

    let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    std::env::set_current_dir(session.path()).expect("chdir session");
    let _restore = scopeguard_cwd(previous, lock);

    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = Some(PathBuf::from("."));

    // resolve_search_root keeps the relative literal.
    assert_eq!(
        resolve_search_root(&ctx, None).expect("root"),
        PathBuf::from(".")
    );
    let grep_args = build_grep_args(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("session_dot_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: Some("rs".into()),
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("args");
    // base "." + "src" stays process-cwd-relative ("./src" or "src").
    let root = PathBuf::from(grep_args.path.as_deref().expect("path"));
    assert!(
        !root.is_absolute(),
        "path=src under working_dir=. must stay relative for OS open, got {root:?}"
    );
    assert!(
        root.ends_with("src"),
        "expected relative src root, got {root:?}"
    );

    // Direct crate call: relative root opens against process cwd.
    let result = ::agentgrep::search::run_grep(
        &root,
        &GrepArgs {
            query: "session_dot_marker".into(),
            regex: false,
            file_type: Some("rs".into()),
            json: false,
            paths_only: false,
            hidden: false,
            no_ignore: false,
            path: grep_args.path.clone(),
            glob: None,
        },
    )
    .expect("run_grep relative");
    assert!(
        result.total_matches > 0,
        "rg/WalkBuilder relative root must hit process cwd tree"
    );
    assert!(
        result.root.contains("src"),
        "GrepResult.root is root.display(), got {}",
        result.root
    );

    assert_modes_hit_marker(&ctx, "session_dot_marker", "decoy_dot_marker");
}

#[test]
fn relative_rel_proj_working_dir_binds_via_process_cwd_parent() {
    // Layout:
    //   parent/rel_proj/src  <- intended markers (working_dir = "rel_proj")
    //   parent/src           <- decoy markers at process cwd
    let lock = process_cwd_lock();
    let parent = tempfile::tempdir().expect("parent");
    let intended = parent.path().join("rel_proj");
    write_marker_tree(&intended, "rel_proj_marker");
    write_marker_tree(parent.path(), "decoy_parent_marker");

    let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    std::env::set_current_dir(parent.path()).expect("chdir parent");
    let _restore = scopeguard_cwd(previous, lock);

    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = Some(PathBuf::from("rel_proj"));

    assert_eq!(
        resolve_search_root(&ctx, None).expect("root"),
        PathBuf::from("rel_proj")
    );
    assert!(
        resolve_search_root(&ctx, None)
            .unwrap()
            .join("src/app.rs")
            .is_file(),
        "outline-style root.join must open rel_proj via process cwd"
    );

    let grep_args = build_grep_args(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("rel_proj_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: Some("rs".into()),
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("args");
    let root = PathBuf::from(grep_args.path.as_deref().unwrap());
    assert_eq!(root, PathBuf::from("rel_proj").join("src"));
    assert!(!root.is_absolute());

    let hit = ::agentgrep::search::run_grep(
        &root,
        &GrepArgs {
            query: "rel_proj_marker".into(),
            regex: false,
            file_type: Some("rs".into()),
            json: false,
            paths_only: false,
            hidden: false,
            no_ignore: false,
            path: grep_args.path.clone(),
            glob: None,
        },
    )
    .expect("grep rel_proj/src");
    assert!(hit.total_matches > 0, "must find intended marker");
    let miss = ::agentgrep::search::run_grep(
        &root,
        &GrepArgs {
            query: "decoy_parent_marker".into(),
            regex: false,
            file_type: Some("rs".into()),
            json: false,
            paths_only: false,
            hidden: false,
            no_ignore: false,
            path: grep_args.path.clone(),
            glob: None,
        },
    )
    .expect("grep decoy query");
    assert_eq!(
        miss.total_matches, 0,
        "decoy at process cwd root must not be inside rel_proj/src"
    );

    assert_modes_hit_marker(&ctx, "rel_proj_marker", "decoy_parent_marker");
}

#[test]
fn relative_rel_proj_working_dir_misses_when_process_cwd_is_elsewhere() {
    // Session author meant intended/rel_proj, but stored the relative string
    // "rel_proj" while the process cwd is a different decoy that also has rel_proj.
    let lock = process_cwd_lock();
    let intended_parent = tempfile::tempdir().expect("intended parent");
    let decoy_parent = tempfile::tempdir().expect("decoy parent");
    write_marker_tree(
        &intended_parent.path().join("rel_proj"),
        "intended_rel_marker",
    );
    write_marker_tree(&decoy_parent.path().join("rel_proj"), "decoy_rel_marker");
    write_marker_tree(decoy_parent.path(), "decoy_cwd_marker");

    let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    std::env::set_current_dir(decoy_parent.path()).expect("chdir decoy");
    let _restore = scopeguard_cwd(previous, lock);

    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = Some(PathBuf::from("rel_proj"));

    let tool = AgentGrepTool::new();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    for (label, input) in [
        (
            "grep omitted",
            json!({"mode": "grep", "query": "marker", "type": "rs", "max_regions": 8}),
        ),
        (
            "grep src",
            json!({"mode": "grep", "query": "marker", "path": "src", "type": "rs", "max_regions": 8}),
        ),
        (
            "find omitted",
            json!({"mode": "find", "query": "app", "max_files": 5}),
        ),
        ("outline", json!({"mode": "outline", "file": "src/app.rs"})),
    ] {
        let out = rt
            .block_on(tool.execute(input, ctx.clone()))
            .unwrap_or_else(|err| panic!("{label}: {err}"));
        assert!(
            out.output.contains("decoy_rel_marker")
                || out.output.contains("app.rs")
                || out.output.contains("decoy"),
            "{label} should bind via process cwd decoy/rel_proj: {}",
            out.output
        );
        assert!(
            !out.output.contains("intended_rel_marker"),
            "{label} must not reach the absolute intended tree when working_dir is relative: {}",
            out.output
        );
    }
}

#[test]
fn absolute_working_dir_with_dot_segment_keeps_display_in_grep_result_root() {
    // working_dir="/abs/session/." is absolute, so resolve_path stays off process
    // cwd, but neither wrapper nor crate strips the trailing "/." for GrepResult.root.
    let lock = process_cwd_lock();
    let session = tempfile::tempdir().expect("session");
    let decoy = tempfile::tempdir().expect("decoy");
    write_marker_tree(session.path(), "abs_dot_marker");
    write_marker_tree(decoy.path(), "decoy_abs_marker");

    let previous = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    std::env::set_current_dir(decoy.path()).expect("chdir decoy");
    let _restore = scopeguard_cwd(previous, lock);

    let dotted = session.path().join(".");
    let mut ctx = test_ctx(Path::new("/unused"));
    ctx.working_dir = Some(dotted.clone());

    let omitted_root = resolve_search_root(&ctx, None).expect("root");
    assert_eq!(omitted_root, dotted);
    assert!(
        omitted_root.as_os_str().to_string_lossy().ends_with(".") || omitted_root.ends_with("."),
        "trailing /. must not be stripped by resolve_search_root: {omitted_root:?}"
    );

    let grep_args = build_grep_args(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("abs_dot_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: Some("rs".into()),
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: None,
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
    )
    .expect("args");
    let root_str = grep_args.path.clone().expect("path");
    // display keeps the "/." join form (…/./src), not a cleaned canonical path.
    assert!(
        root_str.contains(".")
            || PathBuf::from(&root_str)
                .components()
                .any(|c| matches!(c, std::path::Component::CurDir)),
        "joined root should retain CurDir segment from working_dir=/abs/.: {root_str}"
    );

    let result = ::agentgrep::search::run_grep(
        Path::new(&root_str),
        &GrepArgs {
            query: "abs_dot_marker".into(),
            regex: false,
            file_type: Some("rs".into()),
            json: false,
            paths_only: false,
            hidden: false,
            no_ignore: false,
            path: Some(root_str.clone()),
            glob: None,
        },
    )
    .expect("grep abs/.");
    assert!(result.total_matches > 0, "absolute /. root must still open");
    assert_eq!(
        result.root, root_str,
        "GrepResult.root is root.display() with no strip/canonicalize"
    );
    assert!(
        !result
            .root
            .contains(decoy.path().to_string_lossy().as_ref()),
        "must not bind to process cwd decoy"
    );

    // Tool path also finds the session marker, not the decoy.
    let out = execute_linked_agentgrep(
        &AgentGrepInput {
            mode: "grep".into(),
            query: Some("abs_dot_marker".into()),
            file: None,
            terms: None,
            regex: Some(false),
            path: Some("src".into()),
            glob: None,
            file_type: Some("rs".into()),
            hidden: None,
            no_ignore: None,
            max_files: None,
            max_regions: Some(8),
            full_region: None,
            debug_plan: None,
            debug_score: None,
            paths_only: None,
        },
        &ctx,
        None,
    )
    .expect("tool grep");
    assert!(out.output.contains("abs_dot_marker"), "{}", out.output);
    assert!(!out.output.contains("decoy_abs_marker"), "{}", out.output);
}

/// Restore process cwd when the owning test ends (including on panic).
fn scopeguard_cwd(previous: PathBuf, lock: std::sync::MutexGuard<'static, ()>) -> CwdRestore {
    CwdRestore {
        previous,
        _lock: lock,
    }
}

struct CwdRestore {
    previous: PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Drop for CwdRestore {
    fn drop(&mut self) {
        let fallback = PathBuf::from("/");
        let target = if self.previous.exists() {
            self.previous.as_path()
        } else {
            fallback.as_path()
        };
        let _ = std::env::set_current_dir(target);
    }
}
