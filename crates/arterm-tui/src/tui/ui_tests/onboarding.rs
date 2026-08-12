use super::*;
use ratatui::backend::TestBackend;
use ratatui::{Terminal, layout::Rect};

/// Render the onboarding welcome screen for the given state at the given size
/// and return the flattened text of the whole buffer.
fn render_onboarding(state: &TestState, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("failed to create test terminal");
    terminal
        .draw(|frame| {
            let area = Rect::new(0, 0, width, height);
            crate::tui::ui::onboarding::draw_onboarding_welcome(frame, state, area);
        })
        .expect("failed to draw onboarding");

    let buf = terminal.backend().buffer();
    let mut lines = Vec::with_capacity(height as usize);
    for y in 0..height {
        let mut line = String::with_capacity(width as usize);
        for x in 0..width {
            line.push_str(buf[(x, y)].symbol());
        }
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n")
}

fn onboarding_state() -> TestState {
    TestState {
        onboarding_preview: true,
        suggestions: vec![
            ("Log in to get started".to_string(), "/login".to_string()),
            (
                "Build a small CLI tool".to_string(),
                "build a CLI".to_string(),
            ),
        ],
        ..Default::default()
    }
}

#[test]
fn onboarding_welcome_shows_title_and_suggestions_without_a_telemetry_claim() {
    let state = onboarding_state();
    let text = render_onboarding(&state, 80, 30);

    // This used to assert the screen said arterm "collects anonymous usage
    // statistics". Telemetry is opt-in in this fork and off here, so that
    // sentence described a different build. The header is now silent when
    // nothing is sent, and states what IS sent when something is; the wording
    // per level is pinned in `ui_onboarding::telemetry_header_tests`.
    assert!(
        !text.contains("anonymous usage statistics"),
        "a build that sends nothing must not claim to collect:\n{text}"
    );
    assert!(
        text.contains("Welcome to arterm onboarding"),
        "welcome title should be rendered:\n{text}"
    );
    assert!(
        text.contains("Log in to get started"),
        "login suggestion should be rendered:\n{text}"
    );
    assert!(
        text.contains("Build a small CLI tool"),
        "secondary suggestion should be rendered:\n{text}"
    );
    assert!(
        text.contains("Press 1-2 or type anything to start"),
        "numeric hint should reflect suggestion count:\n{text}"
    );
}

#[test]
fn onboarding_welcome_login_suggestion_shows_typed_command() {
    let state = onboarding_state();
    let text = render_onboarding(&state, 80, 30);
    assert!(
        text.contains("(type /login)"),
        "login suggestion should hint the slash command:\n{text}"
    );
}

#[test]
fn onboarding_welcome_renders_on_tiny_area_without_panicking() {
    // Below the donut/full-treatment threshold: should fall back gracefully.
    // The title may be truncated at narrow widths, so only assert its prefix.
    let state = onboarding_state();
    let text = render_onboarding(&state, 20, 5);
    assert!(
        text.contains("Welcome to arterm"),
        "minimal fallback should still show the title:\n{text}"
    );
}

#[test]
fn onboarding_welcome_centers_within_tall_area() {
    // A tall area should leave blank padding above the telemetry header.
    let state = onboarding_state();
    let text = render_onboarding(&state, 80, 40);
    let first_nonblank = text
        .lines()
        .position(|line| !line.trim().is_empty())
        .expect("expected some content");
    assert!(
        first_nonblank > 0,
        "content should be vertically padded from the top:\n{text}"
    );
}

/// The welcome screen replaces the whole message area whenever the transcript
/// is empty and there are suggestions, so it is the screen a launch actually
/// shows. The notes have to be on it, not only on the plain empty screen.
#[test]
fn welcome_screen_carries_the_where_we_left_off_notes() {
    use crate::tui::startup_notes::StartupNote;

    let mut state = onboarding_state();
    state.startup_notes = vec![StartupNote {
        when: chrono::Utc::now() - chrono::Duration::hours(3),
        label: "wire the release workflow to the tap".to_string(),
    }];

    let text = render_onboarding(&state, 100, 40);

    assert!(text.contains("Where we left off here"), "text={text}");
    assert!(
        text.contains("wire the release workflow to the tap"),
        "text={text}"
    );
    assert!(text.contains("3h ago"), "text={text}");
    assert!(
        text.contains("Log in to get started"),
        "the welcome screen's own content must survive: text={text}"
    );
}
