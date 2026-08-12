// Starting a session from the manager's composer, and the step that was
// missing the first time: a switch is not a startup, so nobody read the task.

#[test]
fn test_a_staged_task_is_adopted_after_switching_in_place() {
    let mut app = create_test_app();
    let session_id = "session_launcher_adopt";
    App::save_startup_submission_for_session(
        session_id,
        "wire the release workflow".to_string(),
        Vec::new(),
    );

    app.adopt_staged_submission(session_id);

    assert_eq!(app.input(), "wire the release workflow");
    assert!(
        app.submit_input_on_startup,
        "a staged task must be sent, not just typed into the box"
    );
}

#[test]
fn test_switching_to_a_session_with_nothing_staged_changes_nothing() {
    let mut app = create_test_app();
    app.set_input_for_test("half a thought".to_string());

    app.adopt_staged_submission("session_launcher_nothing_staged");

    assert_eq!(
        app.input(),
        "half a thought",
        "an ordinary switch must not disturb what the user was typing"
    );
    assert!(!app.submit_input_on_startup);
}

/// The wiring, not just the function: the resume path has to call the
/// adoption. Removing that one line left every direct test of
/// `adopt_staged_submission` passing while the product did nothing, which is
/// how this shipped broken the first time.
#[test]
fn test_the_resume_path_adopts_the_staged_task() {
    let mut app = create_test_app();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _guard = rt.enter();
    let mut remote = crate::tui::backend::RemoteConnection::dummy();

    let session_id = "session_launcher_wiring";
    App::save_startup_submission_for_session(session_id, "fix the parser".to_string(), Vec::new());
    app.workspace_client
        .queue_resume_session(session_id.to_string());

    rt.block_on(crate::tui::app::remote::handle_tick(&mut app, &mut remote));

    assert_eq!(
        app.input(),
        "fix the parser",
        "switching sessions must pick up the task the manager staged"
    );
    assert!(app.submit_input_on_startup);
}
