//! What `/device` claims, and which keys the screen answers.
//!
//! Opening the screen touches this machine's identity and its network, so what
//! is pinned here is the part that decides whether a keystroke reaches the
//! screen at all — the failure that cost an evening once already, when a modal
//! was drawn by one dispatch path and answered by neither.

/// `/device` must be recognised on its own, and not steal a longer command that
/// happens to start the same way.
#[test]
fn the_command_claims_only_its_own_name() {
    for claimed in ["/device", "/device ", "/device now"] {
        assert!(
            claimed
                .strip_prefix("/device")
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace)),
            "{claimed} should be handled by /device"
        );
    }
    for other in ["/devices", "/device-list", "/dev"] {
        assert!(
            !other
                .strip_prefix("/device")
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace)),
            "{other} must not be taken by /device"
        );
    }
}

/// Both key paths have to be wired. A modal answered by only one of them is on
/// screen and deaf, which reads as a frozen terminal rather than a bug.
#[test]
fn both_key_dispatch_paths_offer_keys_to_the_pairing_screen() {
    let local = include_str!("input.rs");
    let remote = include_str!("remote/key_handling.rs");

    assert!(
        local.contains("commands_device::handle_pairing_key"),
        "the local key path does not offer keys to the pairing screen"
    );
    assert!(
        remote.contains("commands_device::handle_pairing_key"),
        "the remote key path does not offer keys to the pairing screen"
    );
}

/// The screen is drawn from the render pass and refreshed from both run loops;
/// without the tick it would show whatever was there when it opened.
#[test]
fn the_screen_is_drawn_and_kept_up_to_date() {
    assert!(
        include_str!("../ui.rs").contains("draw_device_pairing"),
        "nothing draws the pairing screen"
    );
    for (name, source) in [
        ("local", include_str!("local.rs")),
        ("remote", include_str!("remote.rs")),
    ] {
        assert!(
            source.contains("poll_device_pairing"),
            "the {name} run loop never refreshes the pairing screen"
        );
    }
}

/// Typing `/` has to offer it, or the command is only findable by knowing it.
#[test]
fn the_command_appears_in_the_palette() {
    assert!(
        include_str!("state_ui_input_helpers.rs").contains(r#""/device""#),
        "/device is not registered in the command palette"
    );
}
