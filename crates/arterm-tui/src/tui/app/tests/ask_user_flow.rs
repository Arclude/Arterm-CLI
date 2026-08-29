// Tests for the pending ask_user question flow: server event -> pending
// state -> key selection -> answer submission.

use crate::tui::app::remote::handle_server_event;
use crate::tui::backend::RemoteConnection;

fn create_ask_test_app() -> App {
    create_test_app()
}

fn pending_question() -> crate::tui::PendingAskUser {
    crate::tui::PendingAskUser {
        request_id: "ask-t1".into(),
        question: "Which approach?".into(),
        options: vec![
            crate::tui::AskUserOptionView {
                label: "Option A".into(),
                detail: None,
            },
            crate::tui::AskUserOptionView {
                label: "Option B".into(),
                detail: Some("slower but safer".into()),
            },
        ],
        allow_custom: true,
        selected: 0,
    }
}

#[test]
fn server_event_stores_pending_question() {
    let mut app = create_ask_test_app();
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();
    let mut remote = RemoteConnection::dummy();
    handle_server_event(
        &mut app,
        crate::protocol::ServerEvent::AskUserRequest {
            request_id: "ask-e1".into(),
            question: "Proceed?".into(),
            options: vec![crate::protocol::AskUserWireOption {
                label: "Yes".into(),
                detail: None,
            }],
            allow_custom_hint: Some("or type your own".into()),
            tool_call_id: "t9".into(),
        },
        &mut remote,
    );
    let pending = app.pending_ask_user.expect("question must be stored");
    assert_eq!(pending.request_id, "ask-e1");
    assert_eq!(pending.question, "Proceed?");
    assert_eq!(pending.options.len(), 1);
    assert!(pending.allow_custom);
    assert_eq!(pending.selected, 0);
}

#[test]
fn digit_selects_and_moves_the_highlight() {
    let mut app = create_ask_test_app();
    app.pending_ask_user = Some(pending_question());

    app.select_ask_user_option(1);
    assert_eq!(app.pending_ask_user.as_ref().unwrap().selected, 1);
    // Out of range is ignored.
    app.select_ask_user_option(5);
    assert_eq!(app.pending_ask_user.as_ref().unwrap().selected, 1);

    app.move_ask_user_selection(1);
    assert_eq!(app.pending_ask_user.as_ref().unwrap().selected, 0, "wraps");
    app.move_ask_user_selection(-1);
    assert_eq!(
        app.pending_ask_user.as_ref().unwrap().selected,
        1,
        "wraps back"
    );
}

#[test]
fn enter_submits_the_highlighted_option() {
    let mut app = create_ask_test_app();
    app.pending_ask_user = Some(pending_question());
    app.select_ask_user_option(1);

    app.submit_ask_user_selection().expect("submit must work");
    assert!(app.pending_ask_user.is_none(), "question cleared");
    let answer = app
        .take_pending_ask_user_answer()
        .expect("answer must be queued");
    assert_eq!(answer.request_id, "ask-t1");
    assert_eq!(answer.selected_index, Some(1));
    assert_eq!(answer.custom, None);
}

#[test]
fn custom_answer_is_queued_not_sent() {
    let mut app = create_ask_test_app();
    app.pending_ask_user = Some(pending_question());

    app.answer_pending_ask_user_custom("do both".into());
    assert!(app.pending_ask_user.is_none());
    let answer = app.take_pending_ask_user_answer().expect("queued");
    assert_eq!(answer.selected_index, None);
    assert_eq!(answer.custom.as_deref(), Some("do both"));
}

#[test]
fn disallowed_custom_answer_restores_the_question() {
    let mut app = create_ask_test_app();
    let mut q = pending_question();
    q.allow_custom = false;
    app.pending_ask_user = Some(q);

    app.answer_pending_ask_user_custom("free text".into());
    assert!(
        app.pending_ask_user.is_some(),
        "question restored when custom answers are disabled"
    );
    assert!(app.take_pending_ask_user_answer().is_none());
}

#[test]
fn inline_ui_state_prefers_ask_over_passive_view() {
    use crate::tui::TuiState;
    let mut app = create_ask_test_app();
    app.inline_view_state = Some(crate::tui::InlineViewState {
        title: "info".into(),
        status: None,
        lines: vec!["line".into()],
    });
    app.pending_ask_user = Some(pending_question());
    match app.inline_ui_state() {
        Some(crate::tui::InlineUiStateRef::AskUser(ask)) => {
            assert_eq!(ask.request_id, "ask-t1");
        }
        other => panic!("expected AskUser, got {other:?}"),
    }
}
