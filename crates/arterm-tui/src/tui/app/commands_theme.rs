//! `/theme` -- pick a named look.
//!
//! Thin on purpose: a theme is a set of role colors, and `[display.colors]` is
//! already the place those live and `/colors` already the way one is edited.
//! This command only names complete sets of them, so the two cannot disagree
//! about what a color is -- `/theme classic` then `/colors set user #fff` is a
//! coherent sequence, and `/theme` afterwards says the look is the user's own
//! rather than still claiming the preset.

use super::{App, DisplayMessage};
use crate::tui::theme_presets::{self, ThemePreset};

/// The argument to `/theme`, or None when `trimmed` is a different command.
///
/// `/themes` and `/themey` share the prefix and are not this command; claiming
/// them would swallow a future command silently rather than fail loudly.
pub(super) fn parse_theme_command(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix("/theme")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim())
}

pub(super) fn handle_theme_command(app: &mut App, trimmed: &str) -> bool {
    let Some(argument) = parse_theme_command(trimmed) else {
        return false;
    };

    match argument {
        "" | "list" => show_themes(app),
        name => apply_theme(app, name),
    }
    true
}

pub(super) fn theme_usage() -> &'static str {
    "Usage: /theme (list the looks) or /theme <name> (switch to one)"
}

fn show_themes(app: &mut App) {
    let configured = crate::config::config().display.colors.clone();
    let active = theme_presets::active(&configured);

    let mut lines = vec!["Themes:".to_string(), String::new()];
    for preset in theme_presets::PRESETS {
        let marker = if active.is_some_and(|found| found.name == preset.name) {
            "●"
        } else {
            "○"
        };
        lines.push(format!("{marker} {:<9} {}", preset.name, preset.summary));
    }

    if active.is_none() {
        lines.push(String::new());
        lines.push(format!(
            "● (your own)  {} role{} edited by hand; /theme <name> replaces them.",
            configured.len(),
            if configured.len() == 1 { "" } else { "s" }
        ));
    }

    lines.push(String::new());
    lines.push(theme_usage().to_string());
    app.push_display_message(DisplayMessage::system(lines.join("\n")));
}

fn apply_theme(app: &mut App, name: &str) {
    let Some(preset) = theme_presets::find(name) else {
        let known: Vec<&str> = theme_presets::PRESETS.iter().map(|p| p.name).collect();
        app.push_display_message(DisplayMessage::error(format!(
            "Unknown theme '{name}'. Known themes: {}.",
            known.join(", ")
        )));
        return;
    };

    match install(preset) {
        Ok(()) => app.push_display_message(DisplayMessage::system(applied_notice(preset))),
        Err(error) => app.push_display_message(DisplayMessage::error(format!(
            "Failed to apply theme '{}': {error}",
            preset.name
        ))),
    }
}

fn applied_notice(preset: &ThemePreset) -> String {
    if preset.colors.is_empty() {
        return format!(
            "Theme: {}. Every color is back to its built-in default.",
            preset.name
        );
    }
    format!(
        "Theme: {}. {} roles repainted, applied immediately.\n{}",
        preset.name,
        preset.colors.len(),
        preset.summary
    )
}

/// Replace `[display.colors]` with `preset`'s and reinstall the live palette.
///
/// Replace, not merge: a theme is a complete set, and merging would leave the
/// previous theme's roles showing through wherever the new one is silent. The
/// reload-patch-save shape is `/colors`'s, so a config edit made by another
/// arterm session in the meantime is not clobbered.
fn install(preset: &ThemePreset) -> anyhow::Result<()> {
    let mut config = crate::config::Config::load();
    config.display.colors = theme_presets::color_map(preset);
    config.save()?;
    crate::tui::theme_detect::init_palette();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claims_the_theme_command() {
        assert_eq!(parse_theme_command("/theme"), Some(""));
        assert_eq!(parse_theme_command("/theme classic"), Some("classic"));
        assert_eq!(parse_theme_command("/theme   classic  "), Some("classic"));
        assert_eq!(parse_theme_command("/theme list"), Some("list"));
        // Shared prefixes belong to whoever registers them later.
        assert_eq!(parse_theme_command("/themes"), None);
        assert_eq!(parse_theme_command("/themey"), None);
        assert_eq!(parse_theme_command("/colors"), None);
    }

    #[test]
    fn usage_names_both_forms() {
        let usage = theme_usage();
        assert!(usage.contains("/theme "));
        assert!(usage.contains("<name>"));
    }

    #[test]
    fn the_default_theme_reads_as_a_reset_not_a_repaint() {
        let arterm = theme_presets::find("arterm").expect("built-in theme");
        let notice = applied_notice(arterm);
        assert!(notice.contains("built-in default"), "{notice}");
        assert!(!notice.contains("roles repainted"), "{notice}");
    }

    #[test]
    fn a_named_theme_reports_how_much_it_changed() {
        let classic = theme_presets::find("classic").expect("ported theme");
        let notice = applied_notice(classic);
        assert!(
            notice.contains(&format!("{} roles repainted", classic.colors.len())),
            "{notice}"
        );
    }
}
