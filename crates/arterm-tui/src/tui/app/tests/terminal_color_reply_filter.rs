// A terminal answering the startup color query late must not type into the
// composer, in either run loop.
//
// The unit tests beside the filter cover the grammar; these cover the wiring,
// which is where this went wrong once already: the filter holds a character
// until its burst ends, and only an idle tick can release it. The local tick
// had that call and the client tick did not — and a plain `arterm` launch runs
// the client loop, so the fix worked everywhere except where it mattered.

use crate::tui::terminal_reply_filter;

/// The reply exactly as crossterm decodes it: the OSC framing is gone and what
/// is left is a run of ordinary characters.
const LATE_REPLY: &str = "11;rgb:1c1c/1c1c/1c1c\\";

fn type_chars(app: &mut App, text: &str) {
    for ch in text.chars() {
        crate::tui::app::input::handle_text_input(app, &ch.to_string());
    }
}

#[test]
fn test_late_color_reply_never_reaches_the_composer() {
    let mut app = create_test_app();
    terminal_reply_filter::arm_for_late_color_reply();

    type_chars(&mut app, LATE_REPLY);

    assert_eq!(
        app.input(),
        "",
        "the terminal's answer must not become a draft"
    );
    terminal_reply_filter::disarm();
}

#[test]
fn test_typing_during_the_guard_window_is_untouched() {
    let mut app = create_test_app();
    terminal_reply_filter::arm_for_late_color_reply();

    type_chars(&mut app, "fix the parser");

    assert_eq!(app.input(), "fix the parser");
    terminal_reply_filter::disarm();
}

#[test]
fn test_local_tick_releases_a_character_held_as_a_possible_reply() {
    let mut app = create_test_app();
    terminal_reply_filter::arm_for_late_color_reply();

    type_chars(&mut app, "z1");
    assert_eq!(app.input(), "z", "the digit could still start a reply");

    std::thread::sleep(std::time::Duration::from_millis(60));
    crate::tui::app::local::handle_tick(&mut app);

    assert_eq!(app.input(), "z1", "the idle tick must release it");
    terminal_reply_filter::disarm();
}

#[test]
fn test_client_tick_releases_a_character_held_as_a_possible_reply() {
    let mut app = create_test_app();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let _guard = rt.enter();
    let mut remote = crate::tui::backend::RemoteConnection::dummy();
    terminal_reply_filter::arm_for_late_color_reply();

    type_chars(&mut app, "z1");
    assert_eq!(app.input(), "z");

    std::thread::sleep(std::time::Duration::from_millis(60));
    rt.block_on(crate::tui::app::remote::handle_tick(&mut app, &mut remote));

    assert_eq!(
        app.input(),
        "z1",
        "the client loop is what a plain `arterm` launch runs"
    );
    terminal_reply_filter::disarm();
}
