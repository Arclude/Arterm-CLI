//! Input handling: what a keystroke does before the composer sees it.
//!
//! Extracted from `input.rs` so the production file stays inside its size
//! budget; the tests are unchanged.

use super::{
    ClipboardPasteContent, ClipboardPasteKind, dropped_image_files, is_clipboard_paste_shortcut,
    parse_dropped_paths, preferred_wayland_text_type, read_clipboard_for_paste_with,
    shifted_printable_fallback, text_input_for_key,
};
use crossterm::event::{KeyCode, KeyModifiers};

#[test]
fn dropped_paths_accept_quotes_shell_escapes_and_file_urls() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first image.png");
    let second = dir.path().join("second.jpg");
    std::fs::write(&first, b"png").unwrap();
    std::fs::write(&second, b"jpeg").unwrap();

    let quoted = parse_dropped_paths(&format!("'{}'", first.display())).unwrap();
    assert_eq!(quoted, vec![first.clone()]);
    let escaped = parse_dropped_paths(&first.display().to_string().replace(' ', "\\ ")).unwrap();
    assert_eq!(escaped, vec![first.clone()]);
    let url = url::Url::from_file_path(&second).unwrap();
    assert_eq!(parse_dropped_paths(url.as_str()).unwrap(), vec![second]);
}

#[test]
fn dropped_images_load_all_supported_files_and_reject_mixed_text() {
    let dir = tempfile::tempdir().unwrap();
    let png = dir.path().join("a.png");
    let jpeg = dir.path().join("b.jpeg");
    std::fs::write(&png, b"png bytes").unwrap();
    std::fs::write(&jpeg, b"jpeg bytes").unwrap();

    let images = dropped_image_files(&format!("'{}' '{}'", png.display(), jpeg.display())).unwrap();
    assert_eq!(images[0], ("image/png".to_string(), b"png bytes".to_vec()));
    assert_eq!(
        images[1],
        ("image/jpeg".to_string(), b"jpeg bytes".to_vec())
    );
    assert!(dropped_image_files("ordinary pasted text").is_none());
}

#[test]
fn smart_paste_prefers_normal_text_when_clipboard_has_text() {
    let content = read_clipboard_for_paste_with(
        &ClipboardPasteKind::Smart,
        || Some("plain text".to_string()),
        || Some(("image/png".to_string(), "base64".to_string())),
        |_| None,
    );

    match content {
        ClipboardPasteContent::Text(text) => assert_eq!(text, "plain text"),
        other => panic!("expected text paste, got {other:?}"),
    }
}

#[test]
fn smart_paste_uses_image_only_when_no_text_is_available() {
    let content = read_clipboard_for_paste_with(
        &ClipboardPasteKind::Smart,
        || None,
        || Some(("image/png".to_string(), "base64".to_string())),
        |_| None,
    );

    match content {
        ClipboardPasteContent::Image {
            media_type,
            base64_data,
        } => {
            assert_eq!(media_type, "image/png");
            assert_eq!(base64_data, "base64");
        }
        other => panic!("expected image paste, got {other:?}"),
    }
}

#[test]
fn smart_paste_empty_clipboard_stays_empty_not_dictation() {
    let content =
        read_clipboard_for_paste_with(&ClipboardPasteKind::Smart, || None, || None, |_| None);

    assert!(
        matches!(content, ClipboardPasteContent::Empty),
        "expected empty paste, got {content:?}"
    );
}

#[test]
fn smart_paste_uses_image_when_text_target_is_blank() {
    // Image-only clipboards can advertise an empty text target; the image
    // must still be pasted instead of producing a silent empty text paste.
    let content = read_clipboard_for_paste_with(
        &ClipboardPasteKind::Smart,
        || Some("   ".to_string()),
        || Some(("image/png".to_string(), "base64".to_string())),
        |_| None,
    );

    match content {
        ClipboardPasteContent::Image {
            media_type,
            base64_data,
        } => {
            assert_eq!(media_type, "image/png");
            assert_eq!(base64_data, "base64");
        }
        other => panic!("expected image paste, got {other:?}"),
    }
}

#[test]
fn paste_shortcut_accepts_control_alt_command_and_meta_v() {
    for modifiers in [
        KeyModifiers::CONTROL,
        KeyModifiers::ALT,
        KeyModifiers::SUPER,
        KeyModifiers::META,
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        KeyModifiers::ALT | KeyModifiers::SHIFT,
        KeyModifiers::SUPER | KeyModifiers::SHIFT,
    ] {
        assert!(
            is_clipboard_paste_shortcut(KeyCode::Char('v'), modifiers),
            "{modifiers:?}+v should paste clipboard contents"
        );
        assert!(
            is_clipboard_paste_shortcut(KeyCode::Char('V'), modifiers),
            "{modifiers:?}+V should paste clipboard contents"
        );
    }

    assert!(!is_clipboard_paste_shortcut(
        KeyCode::Char('v'),
        KeyModifiers::empty()
    ));
}

#[test]
fn wayland_text_type_prefers_utf8_plain_text() {
    let types = "text/plain\ntext/plain;charset=utf-8\nTEXT\nSTRING\nUTF8_STRING\n";

    assert_eq!(
        preferred_wayland_text_type(types),
        Some("text/plain;charset=utf-8")
    );
}

#[test]
fn shifted_printable_fallback_uppercases_ascii_letters() {
    assert_eq!(shifted_printable_fallback('a', KeyModifiers::SHIFT), 'A');
    assert_eq!(shifted_printable_fallback('z', KeyModifiers::SHIFT), 'Z');
}

#[test]
fn shifted_printable_fallback_preserves_terminal_translated_symbols() {
    assert_eq!(shifted_printable_fallback('/', KeyModifiers::SHIFT), '/');
    assert_eq!(shifted_printable_fallback('?', KeyModifiers::SHIFT), '?');
    assert_eq!(shifted_printable_fallback('(', KeyModifiers::SHIFT), '(');
    assert_eq!(shifted_printable_fallback('&', KeyModifiers::SHIFT), '&');
}

#[test]
fn shifted_printable_fallback_does_not_synthesize_us_symbol_layout() {
    assert_eq!(shifted_printable_fallback('7', KeyModifiers::SHIFT), '7');
    assert_eq!(shifted_printable_fallback('8', KeyModifiers::SHIFT), '8');
    assert_eq!(shifted_printable_fallback('=', KeyModifiers::SHIFT), '=');
}

#[test]
fn text_input_for_shifted_symbols_preserves_layout_translated_char() {
    for c in ['/', '?', '(', ')', '&', '=', '"'] {
        assert_eq!(
            text_input_for_key(KeyCode::Char(c), KeyModifiers::SHIFT),
            Some(c.to_string()),
            "shifted {c:?} should be treated as terminal/layout-translated text"
        );
    }
}

#[test]
fn text_input_for_altgr_symbols_preserves_layout_translated_char() {
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;

    for c in ['@', '{', '}', '\\', '€', 'ą'] {
        assert_eq!(
            text_input_for_key(KeyCode::Char(c), altgr),
            Some(c.to_string()),
            "AltGr-style {c:?} should be treated as terminal/layout-translated text"
        );
    }
}

#[test]
fn text_input_for_control_shortcut_letters_stays_non_text() {
    assert_eq!(
        text_input_for_key(
            KeyCode::Char('q'),
            KeyModifiers::CONTROL | KeyModifiers::ALT
        ),
        None
    );
    assert_eq!(
        text_input_for_key(KeyCode::Char('@'), KeyModifiers::CONTROL),
        None
    );
}
