//! The header block travels with the centered transcript.
//!
//! Centering here is block centering, not line centering: every line is padded
//! by the same amount, and that amount is what the *widest* line in the block
//! leaves over. So a single unbounded line -- a deep working directory, a "where
//! we left off" note somebody typed a paragraph into -- silently sets the
//! padding to zero and drops the whole header back into the top-left corner of
//! an otherwise centered screen. Each test below is one line that did exactly
//! that.

use super::*;

/// Centered mode centers the transcript; the header has to travel with it.
/// It is built left-aligned, and leaving it that way put the banner, provider
/// list and cwd in the top-left corner of an otherwise centered screen.
#[test]
fn centered_mode_centers_the_header_block_too() {
    fn header_indent(centered: bool) -> usize {
        let state = TestState {
            centered_mode: centered,
            working_dir: Some("/home/toygar/Belgeler/Arterm-CLI".to_string()),
            ..Default::default()
        };
        let rendered = prepare::prepare_messages(&state, 120, 40)
            .materialize_all_lines()
            .iter()
            .map(extract_line_text)
            .collect::<Vec<_>>();
        rendered
            .iter()
            .find(|line| line.contains("Arterm-CLI"))
            .map(|line| line.len() - line.trim_start().len())
            .expect("the header should name the working directory")
    }

    let left = header_indent(false);
    let centered = header_indent(true);
    assert_eq!(left, 0, "left-aligned mode must not indent the header");
    assert!(
        centered > 0,
        "centered mode must pad the header like the transcript (indent={centered})"
    );
}

/// Centered mode has to survive a small window. The first version capped the
/// header at a flat 96 columns, which centers on a wide terminal and collapses
/// to the left edge on a narrow one -- centered mode that un-centers as the
/// window shrinks.
#[test]
fn the_centered_header_keeps_a_margin_at_every_width() {
    fn indent(width: u16) -> usize {
        let state = TestState {
            centered_mode: true,
            working_dir: Some("/home/toygar/Belgeler/Arterm-CLI".to_string()),
            ..Default::default()
        };
        prepare::prepare_messages(&state, width, 40)
            .materialize_all_lines()
            .iter()
            .map(extract_line_text)
            .find(|line| line.contains("Arterm-CLI"))
            .map(|line| line.len() - line.trim_start().len())
            .expect("the header should name the working directory")
    }

    for width in [80u16, 100, 120, 160, 200] {
        let pad = indent(width);
        assert!(
            pad > 0,
            "a {width}-column terminal should still center the header (indent={pad})"
        );
        assert!(
            pad < width as usize / 2,
            "the header must not be pushed past the middle (width={width}, indent={pad})"
        );
    }
}

/// A deep working directory is the one header line that could outgrow its
/// column: it wrapped onto a second row on a narrow terminal, and in centered
/// mode it was the widest line, so it set the padding for the whole block and
/// pinned the header to the left edge.
#[test]
fn a_long_working_directory_is_elided_rather_than_wrapped() {
    fn header_rows(dir: &str, width: u16) -> Vec<String> {
        let state = TestState {
            working_dir: Some(dir.to_string()),
            ..Default::default()
        };
        prepare::prepare_messages(&state, width, 40)
            .materialize_all_lines()
            .iter()
            .map(extract_line_text)
            .collect()
    }

    let long = "/tmp/claude-1000/-home-toygar-Belgeler-Arterm-CLI/5576df05-5f17-44e4-87ee-fadce3934d45/scratchpad";
    let short = "/tmp/work";
    let width = 80;

    let long_rows = header_rows(long, width);
    let short_rows = header_rows(short, width);

    assert!(
        long_rows
            .iter()
            .all(|line| line.chars().count() <= width as usize),
        "no header line may exceed the terminal width"
    );
    assert!(
        !long_rows.iter().any(|line| line.contains(long)),
        "the full path should not be printed at this width"
    );
    assert!(
        long_rows.iter().any(|line| line.contains("scratchpad")),
        "the elided label must keep the part that identifies the directory: {long_rows:?}"
    );
    assert_eq!(
        long_rows.iter().filter(|l| !l.trim().is_empty()).count(),
        short_rows.iter().filter(|l| !l.trim().is_empty()).count(),
        "a long path must not cost an extra wrapped row"
    );
}

/// The same trap as the working directory, one line further down: a "where we
/// left off" note is a whole sentence somebody typed, and nothing bounded it to
/// the header's column. One long note became the widest line in the block, and
/// since centering pads by what the block leaves over, the padding fell to zero
/// and the entire header -- banner, providers, cwd, notes -- went back to the
/// left edge on a screen whose composer was still centered.
#[test]
fn a_long_note_does_not_pin_the_header_to_the_left() {
    use crate::tui::startup_notes::StartupNote;

    fn rows(width: u16) -> Vec<String> {
        let state = TestState {
            centered_mode: true,
            working_dir: Some("/home/toygar/Belgeler/Arterm-CLI".to_string()),
            startup_notes: vec![StartupNote {
                when: chrono::Utc::now() - chrono::Duration::hours(11),
                label: "Diagrams, Info Widgets, rendering, scrolling, alignment \
                        ozelliklerini nasil test edebiliriz"
                    .to_string(),
            }],
            ..Default::default()
        };
        prepare::prepare_messages(&state, width, 40)
            .materialize_all_lines()
            .iter()
            .map(extract_line_text)
            .collect()
    }

    for width in [80u16, 100, 120, 160] {
        let rendered = rows(width);
        let indent = rendered
            .iter()
            .find(|line| line.contains("Arterm-CLI"))
            .map(|line| line.len() - line.trim_start().len())
            .expect("the header should name the working directory");
        assert!(
            indent > 0,
            "a long note must not un-center the header (width={width}, indent={indent})"
        );

        let note = rendered
            .iter()
            .find(|line| line.contains("11h ago"))
            .expect("the note should be on screen");
        assert!(
            note.chars().count() <= width as usize,
            "the note must fit its own row (width={width}): {note:?}"
        );
        assert!(
            note.trim_start().starts_with("· 11h ago"),
            "the note keeps its age prefix and is cut at the far end: {note:?}"
        );
    }
}

/// The "Updates" box renders in the padding above the header, through its own
/// path. Centering the header alone left the box in the corner of an otherwise
/// centered screen.
#[test]
fn centered_mode_moves_the_updates_box_with_the_header() {
    use crate::tui::ui::header::set_unseen_changelog_entries_override_for_tests;

    set_unseen_changelog_entries_override_for_tests(Some(vec![
        "tui: centered mode stays centered when the window shrinks".to_string(),
    ]));

    let indent = |centered: bool| -> usize {
        let state = TestState {
            centered_mode: centered,
            ..Default::default()
        };
        prepare::prepare_messages(&state, 120, 40)
            .materialize_all_lines()
            .iter()
            .map(extract_line_text)
            .find(|line| line.contains("Updates"))
            .map(|line| line.len() - line.trim_start().len())
            .expect("the updates box should be on screen")
    };

    let left = indent(false);
    let centered = indent(true);
    set_unseen_changelog_entries_override_for_tests(None);

    assert_eq!(left, 0, "left-aligned mode keeps the box at the edge");
    assert!(
        centered > 0,
        "centered mode must move the box with the header (indent={centered})"
    );
}
