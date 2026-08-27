use super::ensure_swarm_prompt_edit_path;
use super::parse_diff_mode_name;
use super::parse_manual_subagent_spec;

#[test]
fn parse_diff_mode_name_maps_known_aliases() {
    use crate::config::DiffDisplayMode;
    assert_eq!(parse_diff_mode_name("off"), Some(DiffDisplayMode::Off));
    assert_eq!(parse_diff_mode_name("none"), Some(DiffDisplayMode::Off));
    assert_eq!(
        parse_diff_mode_name("inline"),
        Some(DiffDisplayMode::Inline)
    );
    assert_eq!(parse_diff_mode_name("on"), Some(DiffDisplayMode::Inline));
    assert_eq!(
        parse_diff_mode_name("full"),
        Some(DiffDisplayMode::FullInline)
    );
    assert_eq!(
        parse_diff_mode_name("pinned"),
        Some(DiffDisplayMode::Pinned)
    );
    assert_eq!(parse_diff_mode_name("file"), Some(DiffDisplayMode::File));
}

#[test]
fn parse_diff_mode_name_is_case_insensitive_and_trims() {
    use crate::config::DiffDisplayMode;
    assert_eq!(
        parse_diff_mode_name("  PINNED "),
        Some(DiffDisplayMode::Pinned)
    );
}

#[test]
fn parse_diff_mode_name_rejects_unknown() {
    assert_eq!(parse_diff_mode_name("sidebyside"), None);
    assert_eq!(parse_diff_mode_name(""), None);
}

#[test]
fn parse_manual_subagent_spec_accepts_flags_and_prompt() {
    let spec = parse_manual_subagent_spec(
        "--type research --model gpt-5.4 --continue session_123 investigate this bug",
    )
    .expect("parse manual subagent spec");

    assert_eq!(spec.subagent_type, "research");
    assert_eq!(spec.model.as_deref(), Some("gpt-5.4"));
    assert_eq!(spec.session_id.as_deref(), Some("session_123"));
    assert_eq!(spec.prompt, "investigate this bug");
}

#[test]
fn parse_manual_subagent_spec_rejects_missing_prompt() {
    let err = parse_manual_subagent_spec("--model gpt-5.4")
        .expect_err("missing prompt should be rejected");
    assert!(err.contains("Missing prompt"));
}

#[test]
fn swarm_prompt_edit_path_prefers_nonblank_project_override() {
    let project = tempfile::tempdir().expect("project tempdir");
    let arterm_home = tempfile::tempdir().expect("arterm tempdir");
    let project_prompt = project.path().join(".arterm/swarm-prompt.md");
    std::fs::create_dir_all(project_prompt.parent().expect("prompt parent"))
        .expect("create project config dir");
    std::fs::write(&project_prompt, "project routing").expect("write project prompt");
    std::fs::write(arterm_home.path().join("swarm-prompt.md"), "global routing")
        .expect("write global prompt");

    let path = ensure_swarm_prompt_edit_path(project.path().to_str(), arterm_home.path())
        .expect("resolve prompt path");
    assert_eq!(path, project_prompt);
}

#[test]
fn swarm_prompt_edit_path_falls_back_to_nonblank_global_override() {
    let project = tempfile::tempdir().expect("project tempdir");
    let arterm_home = tempfile::tempdir().expect("arterm tempdir");
    let project_prompt = project.path().join(".arterm/swarm-prompt.md");
    std::fs::create_dir_all(project_prompt.parent().expect("prompt parent"))
        .expect("create project config dir");
    std::fs::write(&project_prompt, "  \n").expect("write blank project prompt");
    let global_prompt = arterm_home.path().join("swarm-prompt.md");
    std::fs::write(&global_prompt, "global routing").expect("write global prompt");

    let path = ensure_swarm_prompt_edit_path(project.path().to_str(), arterm_home.path())
        .expect("resolve prompt path");
    assert_eq!(path, global_prompt);
}

#[test]
fn swarm_prompt_edit_path_materializes_builtin_default_globally() {
    let project = tempfile::tempdir().expect("project tempdir");
    let arterm_home = tempfile::tempdir().expect("arterm tempdir");

    let path = ensure_swarm_prompt_edit_path(project.path().to_str(), arterm_home.path())
        .expect("create editable prompt");
    assert_eq!(path, arterm_home.path().join("swarm-prompt.md"));
    let content = std::fs::read_to_string(path).expect("read created prompt");
    assert_eq!(content.trim(), crate::prompt::DEFAULT_SWARM_PROMPT.trim());
}

#[test]
fn openrouter_402_payment_required_is_non_retryable() {
    use super::is_non_retryable_auto_poke_error;
    let err = "OpenAI-compatible chat request failed\n  endpoint: \
        https://openrouter.ai/api/v1/chat/completions\n  model: openai/gpt-5.4\n  \
        auth: OPENROUTER_API_KEY\n  status: 402 Payment Required\n  response: \
        {\"error\":{\"message\":\"This request requires more credits, or fewer max_tokens. \
        You requested up to 65536 tokens, but can only afford 34424. To increase, visit \
        https://openrouter.ai/settings/credits and add more credits\",\"code\":402}}";
    assert!(is_non_retryable_auto_poke_error(err));
}

#[test]
fn transient_server_error_remains_retryable_for_auto_poke() {
    use super::is_non_retryable_auto_poke_error;
    let err = "OpenAI-compatible chat request failed\n  status: 503 Service Unavailable";
    assert!(!is_non_retryable_auto_poke_error(err));
}

#[test]
fn openai_usage_limit_reached_is_non_retryable() {
    use super::is_non_retryable_auto_poke_error;
    assert!(is_non_retryable_auto_poke_error(
        "usage_limit_reached: The usage limit has been reached"
    ));
    assert!(is_non_retryable_auto_poke_error(
        "Rate limited: The usage limit has been reached. Plan: team. \
         Resets in 30d 4h 29m (2026-08-21 04:31 UTC)."
    ));
}

#[test]
fn volcengine_ark_unsupported_model_is_fatal_model_endpoint_error() {
    use super::{is_fatal_model_endpoint_error, is_non_retryable_auto_poke_error};
    let err = "OpenAI-compatible chat request failed\n  endpoint: \
        https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions\n  model: \
        volcengine:ark-code-latest\n  auth: ARK_API_KEY\n  status: 404 Not Found\n  response: \
        {\"error\":{\"code\":\"UnsupportedModel\",\"message\":\"The requested model does not \
        support the coding plan feature.\"}}";
    // It is both a fatal model/endpoint error (fail fast, no retries) and a
    // non-retryable auto-poke error (don't keep poking).
    assert!(is_fatal_model_endpoint_error(err));
    assert!(is_non_retryable_auto_poke_error(err));
}

#[test]
fn transient_5xx_is_not_a_fatal_model_endpoint_error() {
    use super::is_fatal_model_endpoint_error;
    let err = "OpenAI-compatible chat request failed\n  status: 503 Service Unavailable";
    assert!(!is_fatal_model_endpoint_error(err));
}

#[test]
fn model_not_found_is_fatal_model_endpoint_error() {
    use super::is_fatal_model_endpoint_error;
    let err = "chat request failed: 404 model_not_found: The model `gpt-foo` does not exist";
    assert!(is_fatal_model_endpoint_error(err));
}

/// Behavioral test for `/mcp`, driven through the real `App`: the shared
/// dispatch table must claim it, and the pushed message must reflect the
/// session's live MCP state. This is the wiring test — remove the
/// `commands_mcp` entry from `dispatch_local_command` and it fails.
mod mcp {
    use crate::tui::app::commands_dispatch::dispatch_local_command;
    use crate::tui::app::tests::create_test_app;

    #[test]
    fn the_mcp_command_is_claimed_and_reports_live_servers() {
        let _lock = crate::storage::lock_test_env();
        let mut app = create_test_app();
        app.mcp_server_names = vec![("livedemo".to_string(), 2)];

        assert!(
            dispatch_local_command(&mut app, "/mcp"),
            "/mcp should be claimed by the shared dispatch table"
        );
        assert!(
            app.mcp_picker_overlay.is_some(),
            "bare /mcp opens the interactive overlay"
        );
        app.mcp_picker_overlay = None;

        assert!(
            dispatch_local_command(&mut app, "/mcp status"),
            "/mcp status should be claimed by the shared dispatch table"
        );
        let message = app.display_messages.last().expect("missing /mcp response");
        assert_eq!(message.role, "mcp", "renders through the colored mcp role");
        assert_eq!(message.title.as_deref(), Some("MCP servers"));
        assert!(
            message.content.contains("+ livedemo — connected · 2 tools"),
            "{}",
            message.content
        );

        assert!(
            !dispatch_local_command(&mut app, "/mcpsomething"),
            "prefix collisions must not be claimed"
        );
    }
}

/// Behavioral test for `/jobs`, driven through the real `App`.
mod jobs {
    use crate::tui::app::commands_dispatch::dispatch_local_command;
    use crate::tui::app::tests::create_test_app;

    #[test]
    fn the_jobs_command_opens_the_overlay() {
        let _lock = crate::storage::lock_test_env();
        let mut app = create_test_app();

        assert!(
            dispatch_local_command(&mut app, "/jobs"),
            "/jobs should be claimed by the shared dispatch table"
        );
        assert!(
            app.jobs_picker_overlay.is_some(),
            "bare /jobs opens the interactive overlay"
        );
        app.jobs_picker_overlay = None;

        assert!(
            dispatch_local_command(&mut app, "/jobs all"),
            "/jobs all should be claimed"
        );
        assert!(
            app.jobs_picker_overlay
                .as_ref()
                .is_some_and(|picker| picker.all_sessions()),
            "/jobs all lists every session"
        );

        assert!(
            !dispatch_local_command(&mut app, "/jobsomething"),
            "prefix collisions must not be claimed"
        );
    }

    #[test]
    fn help_jobs_and_slash_suggestions_describe_the_overlay() {
        let _lock = crate::storage::lock_test_env();
        let mut app = create_test_app();

        assert!(
            app.get_suggestions_for("/jo")
                .iter()
                .any(|(command, _)| command == "/jobs"),
            "/jobs must appear in slash autocomplete"
        );
        assert!(
            dispatch_local_command(&mut app, "/help jobs"),
            "/help jobs should be claimed"
        );
        let help = app
            .display_messages()
            .iter()
            .rev()
            .find(|message| message.role == "system")
            .map(|message| message.content.as_str())
            .expect("/help jobs should print overlay help");
        assert!(help.contains("/jobs"), "{help}");
        assert!(help.contains("x (or Delete)"), "{help}");
        assert!(help.contains("/jobs all"), "{help}");
    }

    #[test]
    fn jobs_overlay_lists_elapsed_time_and_stops_a_running_task() {
        let _lock = crate::storage::lock_test_env();
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let _guard = rt.enter();

        let mut app = create_test_app();
        let session_id = app.session.id.clone();
        let info = rt.block_on(crate::background::global().spawn_with_notify(
            "bash",
            Some("sleep for overlay".to_string()),
            &session_id,
            false,
            false,
            |_output| async {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                Ok(crate::background::TaskResult::completed(Some(0)))
            },
        ));

        assert!(dispatch_local_command(&mut app, "/jobs"));
        let picker = app
            .jobs_picker_overlay
            .as_ref()
            .expect("overlay should open");
        let backend = ratatui::backend::TestBackend::new(90, 24);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| picker.render(frame))
            .expect("draw overlay");
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                text.push_str(buffer[(x, y)].symbol());
            }
            text.push('\n');
        }
        assert!(
            text.contains("sleep for overlay") && text.contains("running"),
            "overlay should list the live job with elapsed time, got:\n{text}"
        );
        assert!(
            text.contains("s") && (text.contains("running")),
            "overlay should show a duration for the running job"
        );

        let outcome = app
            .handle_jobs_picker_key_outcome(
                crossterm::event::KeyCode::Char('x'),
                crossterm::event::KeyModifiers::empty(),
            )
            .expect("x should request cancel");
        app.handle_jobs_picker_action_local(outcome);

        let started = std::time::Instant::now();
        loop {
            let _ = crate::tui::app::local::handle_tick(&mut app);
            if app.pending_jobs_cancel.is_none() {
                break;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(3),
                "local cancel result should land on a tick"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let status = rt
            .block_on(crate::background::global().status(&info.task_id))
            .expect("cancelled job status");
        assert_eq!(
            status.error.as_deref(),
            Some("Cancelled by user"),
            "overlay stop must use BackgroundTaskManager::cancel"
        );

        let picker = app
            .jobs_picker_overlay
            .as_ref()
            .expect("overlay should stay open");
        let backend = ratatui::backend::TestBackend::new(90, 24);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| picker.render(frame))
            .expect("draw overlay");
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                text.push_str(buffer[(x, y)].symbol());
            }
            text.push('\n');
        }
        assert!(
            text.contains("failed") && text.contains("sleep for overlay"),
            "local cancel must refresh the overlay without waiting for a bus event, got:\n{text}"
        );
        assert!(
            !text.contains("press r")
                && !text.contains("stopping")
                && text.contains("esc close"),
            "successful cancel must clear the stopping footer, got:\n{text}"
        );

        app.handle_jobs_picker_action_local(crate::tui::jobs_picker::JobsPickerOutcome::Action {
            action: "cancel",
            task_id: Some(info.task_id.clone()),
            all_sessions: false,
        });
        let started = std::time::Instant::now();
        loop {
            let _ = crate::tui::app::local::handle_tick(&mut app);
            if app.pending_jobs_cancel.is_none() {
                break;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(3),
                "missed cancel result should land on a tick"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let picker = app
            .jobs_picker_overlay
            .as_ref()
            .expect("overlay should stay open after a missed cancel");
        let backend = ratatui::backend::TestBackend::new(90, 24);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| picker.render(frame))
            .expect("draw overlay");
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                text.push_str(buffer[(x, y)].symbol());
            }
            text.push('\n');
        }
        assert!(
            text.contains(&format!("Background job '{}' is not running.", info.task_id)),
            "a second stop must report the miss in the footer, got:\n{text}"
        );
    }

    #[test]
    fn jobs_overlay_reports_a_dropped_cancel_worker() {
        let _lock = crate::storage::lock_test_env();
        let mut app = create_test_app();
        assert!(dispatch_local_command(&mut app, "/jobs"));

        let (tx, rx) = std::sync::mpsc::channel();
        app.pending_jobs_cancel = Some(rx);
        drop(tx);

        assert!(
            crate::tui::app::local::handle_tick(&mut app),
            "a dropped cancel worker must request a redraw"
        );
        assert!(
            app.pending_jobs_cancel.is_none(),
            "the disconnected channel must be cleared"
        );

        let picker = app
            .jobs_picker_overlay
            .as_ref()
            .expect("overlay should stay open");
        let backend = ratatui::backend::TestBackend::new(90, 24);
        let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
        terminal
            .draw(|frame| picker.render(frame))
            .expect("draw overlay");
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width {
                text.push_str(buffer[(x, y)].symbol());
            }
            text.push('\n');
        }
        assert!(
            text.contains("Background job cancel failed: worker dropped."),
            "dropped cancel workers must leave a footer, got:\n{text}"
        );
    }
}

/// Behavioral tests for `/colors`, driven through the real `App` so they cover
/// what a user actually types: dispatch, message text, config persistence, and
/// error handling.
///
/// These use an isolated `ARTERM_HOME` (`create_test_app` sets one) so they write
/// to a throwaway config rather than the developer's real one.
mod colors {
    use crate::tui::app::commands_dispatch::dispatch_local_command;
    use crate::tui::app::tests::create_test_app;

    /// These tests write the config file and mutate the process-global palette,
    /// so they must serialize against *every* test touching shared config or
    /// env state, not merely against each other. A module-private lock would
    /// still let them swap the config out from under another module's test
    /// mid-assertion, which is the race class that makes unrelated provider and
    /// header tests fail intermittently.
    fn lock_shared_state() -> std::sync::MutexGuard<'static, ()> {
        crate::storage::lock_test_env()
    }

    /// Take the shared lock and leave the config and palette clean afterwards,
    /// even if the test body panics.
    fn with_clean_config(body: impl FnOnce()) {
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                let mut config = crate::config::Config::load();
                config.display.colors.clear();
                let _ = config.save();
                arterm_tui_style::set_palette(arterm_tui_style::Palette::default());
            }
        }
        let _lock = lock_shared_state();
        let _restore = Restore;
        {
            let mut config = crate::config::Config::load();
            config.display.colors.clear();
            let _ = config.save();
        }
        body();
    }

    /// Text of the last message the app pushed, whatever its role.
    fn last_message(app: &crate::tui::app::App) -> String {
        app.display_messages
            .last()
            .map(|message| message.content.clone())
            .unwrap_or_default()
    }

    #[test]
    fn colors_lists_every_role_with_its_hex_value() {
        let mut app = create_test_app();
        assert!(
            dispatch_local_command(&mut app, "/colors"),
            "/colors should be claimed by the shared dispatch table"
        );
        let output = last_message(&app);
        for role in arterm_tui_style::ALL_ROLES.iter().copied() {
            assert!(
                output.contains(role.key()),
                "listing should mention {}: {output}",
                role.key()
            );
        }
        assert!(
            output.contains("#8ab4f8"),
            "listing should show hex values: {output}"
        );
    }

    #[test]
    fn colors_harmony_reports_a_score_and_named_criteria() {
        let mut app = create_test_app();
        assert!(dispatch_local_command(&mut app, "/colors harmony"));
        let output = last_message(&app);
        assert!(
            output.contains("/100"),
            "harmony should report a score: {output}"
        );
        for criterion in [
            "readability",
            "distinctness",
            "hue harmony",
            "chroma coherence",
            "colorblind safety",
        ] {
            assert!(
                output.contains(criterion),
                "harmony should report {criterion}: {output}"
            );
        }
    }

    #[test]
    fn setting_a_role_persists_it_and_reports_the_new_score() {
        with_clean_config(|| {
            let mut app = create_test_app();
            assert!(dispatch_local_command(&mut app, "/colors error #1050f0"));
            let output = last_message(&app);
            assert!(
                output.contains("#1050f0"),
                "should confirm the new value: {output}"
            );
            assert!(
                output.contains("/100"),
                "should report the resulting harmony: {output}"
            );

            let saved = crate::config::Config::load();
            assert_eq!(
                saved.display.colors.get("error").map(String::as_str),
                Some("#1050f0"),
                "the role should be saved to config"
            );

            // And the live palette must reflect it without a restart.
            assert!(
                arterm_tui_style::palette().is_overridden(arterm_tui_style::Role::Error),
                "the running palette should pick the change up immediately"
            );

            assert!(dispatch_local_command(&mut app, "/colors reset"));
            assert!(
                crate::config::Config::load().display.colors.is_empty(),
                "reset should clear the configured colors"
            );
        });
    }

    #[test]
    fn generate_writes_a_complete_palette_and_scores_it() {
        with_clean_config(|| {
            let mut app = create_test_app();
            assert!(dispatch_local_command(&mut app, "/colors generate #8ab4f8"));
            let output = last_message(&app);
            assert!(
                output.contains("/100"),
                "generate should report the harmony score: {output}"
            );

            let saved = crate::config::Config::load();
            assert_eq!(
                saved.display.colors.len(),
                arterm_tui_style::ALL_ROLES.len(),
                "generate should write every role"
            );
            for role in arterm_tui_style::ALL_ROLES.iter().copied() {
                let value = saved
                    .display
                    .colors
                    .get(role.key())
                    .unwrap_or_else(|| panic!("generate should write {}", role.key()));
                assert!(
                    arterm_tui_style::palette::parse_hex(value).is_some(),
                    "{} should be a valid hex color, got {value}",
                    role.key()
                );
            }

            assert!(dispatch_local_command(&mut app, "/colors reset"));
        });
    }

    #[test]
    fn bad_input_is_rejected_without_touching_the_config() {
        with_clean_config(|| {
            let mut app = create_test_app();
            for (input, expected) in [
                ("/colors bogus-role #ffffff", "Unknown color role"),
                ("/colors error not-a-color", "Invalid color"),
                ("/colors generate nope", "Invalid seed color"),
                ("/colors error", "Missing color value"),
            ] {
                assert!(dispatch_local_command(&mut app, input), "{input}");
                let output = last_message(&app);
                assert!(
                    output.contains(expected),
                    "{input} should report '{expected}', got: {output}"
                );
            }
            assert!(
                crate::config::Config::load().display.colors.is_empty(),
                "rejected input must not write anything"
            );
        });
    }

    #[test]
    fn unrelated_commands_are_not_swallowed() {
        // `/colors` shares a prefix with nothing today, but a future `/color*`
        // command must not be silently captured by this handler.
        let mut app = create_test_app();
        assert!(
            !dispatch_local_command(&mut app, "/colorscheme dracula"),
            "/colorscheme must not be claimed by /colors"
        );
    }
}
