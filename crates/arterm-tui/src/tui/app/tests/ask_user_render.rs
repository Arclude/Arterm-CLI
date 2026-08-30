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
    let content = terminal.backend().buffer().content();
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

#[test]
fn long_labels_wrap_instead_of_truncating() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();
    let mut app = create_test_app();
    let long_label = "Veritabani semasini sifirdan kur ve tum migration'lari tekrar uygula ".to_string()
        + "ve seed verilerini yeniden yukle ve cache'i temizle";
    app.pending_ask_user = Some(crate::tui::PendingAskUser {
        request_id: "ask-w1".into(),
        question: "Cok uzun bir soru metni burada yer aliyor ve dar terminale sigmasi gerekiyor mu?".into(),
        options: vec![
            crate::tui::AskUserOptionView {
                label: long_label.clone(),
                detail: Some("Bu detay satiri da cok uzun ve kesinlikle sigmaz tek satira".into()),
            },
            crate::tui::AskUserOptionView {
                label: "Kisa".into(),
                detail: None,
            },
        ],
        allow_custom: true,
        selected: 0,
    });

    // Narrow terminal: 40 cols. The label must appear COMPLETE (wrapped), not cut.
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 30))
        .expect("terminal");
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, &app))
        .expect("draw");
    let content = terminal.backend().buffer().content();
    let text: String = content
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect();

    // Words from the tail of the long label must survive the wrap.
    assert!(
        text.contains("temizle"),
        "wrapped label tail missing (truncated?): {text:?}"
    );
    assert!(
        text.contains("sigmasi"),
        "wrapped question tail missing: {text:?}"
    );
    assert!(
        text.contains("kesinlikle"),
        "wrapped detail tail missing: {text:?}"
    );
    // Second option must still be visible below the wrapped first.
    assert!(text.contains("2. Kisa"), "second option lost: {text:?}");
}

#[test]
fn wrap_plain_splits_words_and_hard_breaks_tokens() {
    // Direct unit checks for the wrapper used by the ask_user box.
    let lines = crate::tui::ui::wrap_plain_for_test(
        "kisa cumle burada",
        10,
    );
    assert!(lines.len() >= 2, "expected wrap, got {lines:?}");
    for line in &lines {
        assert!(unicode_width::UnicodeWidthStr::width(line.as_str()) <= 10);
    }
    // Unbreakable long token is hard-split, never dropped.
    let hard = crate::tui::ui::wrap_plain_for_test("aaaaaaaaaaaaaaaaaaaa", 6);
    assert_eq!(hard.len(), 4, "hard split: {hard:?}");
    assert!(hard.iter().all(|l| unicode_width::UnicodeWidthStr::width(l.as_str()) <= 6));
}
