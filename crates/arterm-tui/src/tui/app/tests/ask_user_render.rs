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

fn frame_text(
    terminal: &mut ratatui::Terminal<ratatui::backend::TestBackend>,
    app: &App,
) -> String {
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, app))
        .expect("draw");
    terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect()
}

fn five_option_question(selected: usize) -> crate::tui::PendingAskUser {
    let options = ["Birinci", "Ikinci", "Ucuncu", "Dorduncu", "Besinci"]
        .into_iter()
        .map(|label| crate::tui::AskUserOptionView {
            label: label.into(),
            detail: None,
        })
        .collect();
    crate::tui::PendingAskUser {
        request_id: "ask-scroll".into(),
        question: "Hangi secenegi istersin?".into(),
        options,
        allow_custom: true,
        selected,
    }
}

#[test]
fn small_terminal_scrolls_to_keep_highlighted_option_visible() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();

    // Select the LAST option: on a short terminal the list must scroll down
    // so the highlighted option (and its marker) is on screen.
    let mut app = create_test_app();
    app.pending_ask_user = Some(five_option_question(4));
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12))
        .expect("terminal");
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, &app))
        .expect("draw");
    let text: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect();
    assert!(
        text.contains("▸ 5. Besinci"),
        "highlighted last option must be visible after scroll, got:\n{text}"
    );
    // The scroll indicator replaces the old enlarge-your-terminal message.
    assert!(
        !text.contains("büyüt"),
        "no enlarge-terminal message expected"
    );
}

#[test]
fn moving_highlight_scrolls_the_viewport() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();

    let mut app = create_test_app();
    app.pending_ask_user = Some(five_option_question(0));
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12))
        .expect("terminal");

    let before = frame_text(&mut terminal, &app);
    assert!(
        before.contains("▸ 1. Birinci"),
        "first option visible initially"
    );

    // Move the highlight to the last option: the viewport must follow it.
    app.move_ask_user_selection(1);
    app.move_ask_user_selection(1);
    app.move_ask_user_selection(1);
    app.move_ask_user_selection(1);
    let after = frame_text(&mut terminal, &app);
    assert!(
        after.contains("▸ 5. Besinci"),
        "viewport must scroll to the newly highlighted option, got:\n{after}"
    );
    // Key hint stays pinned at the bottom of the box even while scrolled.
    assert!(
        after.contains("1-9/↑↓ choose"),
        "key hint must stay pinned while scrolled"
    );
}

#[test]
fn large_terminal_shows_everything_without_scroll() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();

    let mut app = create_test_app();
    app.pending_ask_user = Some(five_option_question(0));
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 40))
        .expect("terminal");
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, &app))
        .expect("draw");
    let text: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect();
    for needle in ["1. Birinci", "2. Ikinci", "3. Ucuncu", "4. Dorduncu", "5. Besinci"] {
        assert!(text.contains(needle), "missing {needle}");
    }
    assert!(
        !text.contains("more"),
        "no scroll indicator expected when everything fits"
    );
}

#[test]
fn tiny_terminal_still_renders_box_and_highlight() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();

    // 10-row terminal with 5 options: the box must render with the
    // highlighted option visible rather than vanishing or truncating away.
    let mut app = create_test_app();
    app.pending_ask_user = Some(five_option_question(2));
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(50, 10))
        .expect("terminal");
    terminal
        .draw(|frame| crate::tui::ui::draw(frame, &app))
        .expect("draw");
    let text: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol().to_string())
        .collect();
    assert!(
        text.contains("▸ 3. Ucuncu"),
        "highlighted option must be visible on a 10-row terminal, got:\n{text}"
    );
}

#[test]
fn extreme_small_terminal_keeps_highlight_reachable() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _guard = rt.enter();

    // 8-row terminal: the layout still reserves the status line + input, so
    // the inline box gets only a few rows. The highlighted option must still
    // be the row the user sees (the scroll targets it), proving the list
    // never gets stuck at the top and the box never collapses to nothing.
    for selected in 0..5 {
        let mut app = create_test_app();
        app.pending_ask_user = Some(five_option_question(selected));
        let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(50, 8))
            .expect("terminal");
        terminal
            .draw(|frame| crate::tui::ui::draw(frame, &app))
            .expect("draw");
        let text: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol().to_string())
            .collect();
        let expected = format!("▸ {}.", selected + 1);
        assert!(
            text.contains(&expected),
            "selected {selected} must stay visible on an 8-row terminal (expected {expected}), got:\n{text}"
        );
    }
}
