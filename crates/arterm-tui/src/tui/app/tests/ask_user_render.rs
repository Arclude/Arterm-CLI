// Offscreen render check: a pending ask_user question must draw the numbered
// option list in the inline block area.
#[test]
fn pending_ask_user_renders_options_offscreen() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();
    let mut app = create_test_app();
    app.pending_ask_user = Some(crate::tui::PendingAskUser {
        request_id: "ask-r1".into(),
        question: "Render check?".into(),
        options: vec![
            crate::tui::AskUserOptionView {
                label: "Alpha".into(),
                detail: None,
            },
            crate::tui::AskUserOptionView {
                label: "Beta".into(),
                detail: Some("second".into()),
            },
        ],
        allow_custom: true,
        selected: 0,
    });

    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(100, 30))
        .expect("terminal");
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, &app))
        .expect("draw");
    let content = terminal.backend().buffer().content().clone();
    let text: String = content
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect();
    assert!(text.contains("Render check?"), "question must render");
    assert!(text.contains("Alpha"), "option 1 must render");
    assert!(text.contains("Beta"), "option 2 must render");
    assert!(
        text.contains("▸ 1. Alpha"),
        "highlight marker on option 1, got: {text:?}"
    );
}
