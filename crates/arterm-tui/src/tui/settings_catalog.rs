//! The `[display]` settings `/config` can edit, and how a change is written.
//!
//! Editing settings by hand means finding `~/.arterm/config.toml`, knowing the
//! key, knowing its spelling, and reloading. This catalog is the same knowledge
//! written once, in a form the overlay can render and the writer can apply:
//! every entry knows its key, what it does, which values are legal, and how to
//! read and write itself on a [`Config`].
//!
//! Scope is deliberately `[display]`. Provider credentials, sandbox paths and
//! launch hotkeys all have their own commands (`/login`, `/model`,
//! `setup-hotkey`) and a wrong value there breaks a session rather than a
//! colour; a settings list that mixes the two invites exactly that mistake.
//!
//! # Writing
//!
//! [`apply`] reloads the config from disk, patches one field, and saves — never
//! serializing the process's cached copy. Another arterm session editing a
//! different setting at the same moment would otherwise be clobbered by
//! whatever this process happened to have in memory. The same
//! reload-patch-save shape `/colors` uses.

use arterm_config_types::{
    DiagramDisplayMode, DiffDisplayMode, LatexRenderingMode, MarkdownSpacingMode,
    OverscrollStatusMode, ReasoningDisplayMode,
};

use crate::config::Config;

/// One editable setting.
pub struct Setting {
    /// The TOML key under `[display]`, shown as the row's name so what the user
    /// sees is what they would have typed by hand.
    pub key: &'static str,
    /// One line on what it does, shown under the selected row.
    pub help: &'static str,
    /// Every legal value, in the order they cycle.
    pub values: &'static [&'static str],
    /// Read the current value out of a config.
    read: fn(&Config) -> String,
    /// Write a value into a config. Returns false when the value is not one of
    /// `values` (the overlay cannot produce that, but a future caller could).
    write: fn(&mut Config, &str) -> bool,
}

impl Setting {
    /// The value this setting currently has.
    pub fn current(&self, config: &Config) -> String {
        (self.read)(config)
    }

    /// Index of the current value in `values`, or 0 when the config holds
    /// something outside the catalog (a hand-edited file).
    pub fn current_index(&self, config: &Config) -> usize {
        let current = self.current(config);
        self.values
            .iter()
            .position(|value| *value == current)
            .unwrap_or(0)
    }
}

const BOOL: &[&str] = &["false", "true"];
const COUNT_0_5: &[&str] = &["0", "1", "2", "3", "4", "5"];

/// Every `[display]` setting `/config` offers, in the order they are listed.
///
/// Ordered by how often a person reaches for them, not alphabetically: the
/// layout and rendering switches first, the smaller comfort toggles after.
pub fn display_settings() -> &'static [Setting] {
    &[
        Setting {
            key: "centered",
            help: "Center the transcript and composer instead of aligning left.",
            values: BOOL,
            read: |c| bool_str(c.display.centered),
            write: |c, v| parse_bool(v).map(|b| c.display.centered = b).is_some(),
        },
        Setting {
            key: "diagram_mode",
            help: "Where Mermaid diagrams render. `none` still draws them inline.",
            values: &["none", "margin", "pinned"],
            read: |c| {
                match c.display.diagram_mode {
                    DiagramDisplayMode::None => "none",
                    DiagramDisplayMode::Margin => "margin",
                    DiagramDisplayMode::Pinned => "pinned",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "none" => DiagramDisplayMode::None,
                    "margin" => DiagramDisplayMode::Margin,
                    "pinned" => DiagramDisplayMode::Pinned,
                    _ => return false,
                };
                c.display.diagram_mode = mode;
                true
            },
        },
        Setting {
            key: "theme",
            help: "Palette. `auto` asks the terminal for its background color.",
            values: &["auto", "dark", "light"],
            read: |c| {
                let theme = c.display.theme.trim();
                if theme.is_empty() {
                    "auto".to_string()
                } else {
                    theme.to_ascii_lowercase()
                }
            },
            write: |c, v| {
                if !matches!(v, "auto" | "dark" | "light") {
                    return false;
                }
                // "auto" is the empty string on disk: the config's own default.
                c.display.theme = if v == "auto" {
                    String::new()
                } else {
                    v.to_string()
                };
                true
            },
        },
        Setting {
            key: "diff_mode",
            help: "How file edits are shown: inline, in a pane, or as a file view.",
            values: &["off", "inline", "full-inline", "pinned", "file"],
            read: |c| {
                match c.display.diff_mode {
                    DiffDisplayMode::Off => "off",
                    DiffDisplayMode::Inline => "inline",
                    DiffDisplayMode::FullInline => "full-inline",
                    DiffDisplayMode::Pinned => "pinned",
                    DiffDisplayMode::File => "file",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "off" => DiffDisplayMode::Off,
                    "inline" => DiffDisplayMode::Inline,
                    "full-inline" => DiffDisplayMode::FullInline,
                    "pinned" => DiffDisplayMode::Pinned,
                    "file" => DiffDisplayMode::File,
                    _ => return false,
                };
                c.display.diff_mode = mode;
                true
            },
        },
        Setting {
            key: "markdown_spacing",
            help: "Blank-line density in rendered markdown.",
            values: &["compact", "document"],
            read: |c| {
                match c.display.markdown_spacing {
                    MarkdownSpacingMode::Compact => "compact",
                    MarkdownSpacingMode::Document => "document",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "compact" => MarkdownSpacingMode::Compact,
                    "document" => MarkdownSpacingMode::Document,
                    _ => return false,
                };
                c.display.markdown_spacing = mode;
                true
            },
        },
        Setting {
            key: "latex_rendering",
            help: "How LaTeX is drawn: not at all, as Unicode, or as an image.",
            values: &["none", "unicode", "image"],
            read: |c| {
                match c.display.latex_rendering {
                    LatexRenderingMode::None => "none",
                    LatexRenderingMode::Unicode => "unicode",
                    LatexRenderingMode::Image => "image",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "none" => LatexRenderingMode::None,
                    "unicode" => LatexRenderingMode::Unicode,
                    "image" => LatexRenderingMode::Image,
                    _ => return false,
                };
                c.display.latex_rendering = mode;
                true
            },
        },
        // `show_thinking` is deliberately absent: it is the legacy half of this
        // setting, and `set_reasoning_display` keeps it in sync. Offering both
        // as independent rows would let a user build a pair that contradicts
        // itself (thinking off, trace full).
        Setting {
            key: "reasoning_display",
            help: "Whether the model's reasoning trace is shown, and how much.",
            values: &["off", "current", "full"],
            read: |c| {
                match c.display.reasoning_display() {
                    ReasoningDisplayMode::Off => "off",
                    ReasoningDisplayMode::Current => "current",
                    ReasoningDisplayMode::Full => "full",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "off" => ReasoningDisplayMode::Off,
                    "current" => ReasoningDisplayMode::Current,
                    "full" => ReasoningDisplayMode::Full,
                    _ => return false,
                };
                c.display.set_reasoning_display(mode);
                true
            },
        },
        Setting {
            key: "overscroll_status",
            help: "The status line below the input when scrolling past the end.",
            values: &["off", "on", "overscroll"],
            read: |c| {
                match c.display.overscroll_status {
                    OverscrollStatusMode::Off => "off",
                    OverscrollStatusMode::On => "on",
                    OverscrollStatusMode::Overscroll => "overscroll",
                }
                .to_string()
            },
            write: |c, v| {
                let mode = match v {
                    "off" => OverscrollStatusMode::Off,
                    "on" => OverscrollStatusMode::On,
                    "overscroll" => OverscrollStatusMode::Overscroll,
                    _ => return false,
                };
                c.display.overscroll_status = mode;
                true
            },
        },
        Setting {
            key: "active_sessions_manager",
            help: "Left arrow on an empty prompt opens the live sessions manager.",
            values: BOOL,
            read: |c| bool_str(c.display.active_sessions_manager),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.active_sessions_manager = b)
                    .is_some()
            },
        },
        Setting {
            key: "external_sessions",
            help: "List transcripts from other agent CLIs in the session picker.",
            values: BOOL,
            read: |c| bool_str(c.display.external_sessions),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.external_sessions = b)
                    .is_some()
            },
        },
        Setting {
            key: "recent_notes",
            help: "How many \"where we left off\" lines the startup screen shows.",
            values: COUNT_0_5,
            read: |c| c.display.recent_notes.to_string(),
            write: |c, v| match v.parse::<usize>() {
                Ok(n) => {
                    c.display.recent_notes = n;
                    true
                }
                Err(_) => false,
            },
        },
        Setting {
            key: "pin_todos",
            help: "Keep the session's todo list pinned above the transcript.",
            values: BOOL,
            read: |c| bool_str(c.display.pin_todos),
            write: |c, v| parse_bool(v).map(|b| c.display.pin_todos = b).is_some(),
        },
        Setting {
            key: "pin_images",
            help: "Pin images that were read into the side pane.",
            values: BOOL,
            read: |c| bool_str(c.display.pin_images),
            write: |c, v| parse_bool(v).map(|b| c.display.pin_images = b).is_some(),
        },
        Setting {
            key: "tool_call_details",
            help: "Show each tool call's technical detail instead of a summary.",
            values: BOOL,
            read: |c| bool_str(c.display.tool_call_details),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.tool_call_details = b)
                    .is_some()
            },
        },
        Setting {
            key: "keybinding_hints",
            help: "Show the shortcut hints under the composer.",
            values: BOOL,
            read: |c| bool_str(c.display.keybinding_hints),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.keybinding_hints = b)
                    .is_some()
            },
        },
        Setting {
            key: "prompt_preview",
            help: "Keep the previous prompt visible while its answer streams.",
            values: BOOL,
            read: |c| bool_str(c.display.prompt_preview),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.prompt_preview = b)
                    .is_some()
            },
        },
        Setting {
            key: "compact_notifications",
            help: "Condense notification lines to a single row.",
            values: BOOL,
            read: |c| bool_str(c.display.compact_notifications),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.compact_notifications = b)
                    .is_some()
            },
        },
        // The one non-`[display]` entry, and it earns the exception: the
        // sandbox is on by default, so the person it inconveniences needs a way
        // to turn it off that is not "find config.toml and learn a key". Every
        // other excluded setting has its own command (`/login`, `/model`); this
        // one had nothing.
        //
        // Its companion key `sandbox_writable_roots` is deliberately NOT here.
        // A `Setting` is a closed list of values the overlay cycles through
        // (`values`, `current_index`), and a list of arbitrary filesystem paths
        // is neither closed nor cyclable -- offering it here would mean a row
        // that cannot be edited, which is worse than no row. It stays a
        // config.toml key, and the sandbox's own refusal message names it at
        // the moment someone needs it.
        Setting {
            key: "sandbox_mode",
            help: "Restrict what agent-run bash commands may write and connect to.",
            values: &["workspace-write", "read-only", "full-access"],
            read: |c| {
                let mode = c.sandbox_mode.trim();
                if mode.is_empty() {
                    // Empty means unset, and `apply_defaults` resolves it on
                    // load; show what is in force, not the blank in the file.
                    crate::config::default_sandbox_mode()
                } else {
                    mode.to_string()
                }
            },
            write: |c, v| {
                if !matches!(v, "workspace-write" | "read-only" | "full-access") {
                    return false;
                }
                c.sandbox_mode = v.to_string();
                true
            },
        },
        Setting {
            key: "idle_animation",
            help: "Animate the idle indicator between turns.",
            values: BOOL,
            read: |c| bool_str(c.display.idle_animation),
            write: |c, v| {
                parse_bool(v)
                    .map(|b| c.display.idle_animation = b)
                    .is_some()
            },
        },
        Setting {
            key: "emoji",
            help: "Use emoji in TUI and CLI output.",
            values: BOOL,
            read: |c| bool_str(c.display.emoji),
            write: |c, v| parse_bool(v).map(|b| c.display.emoji = b).is_some(),
        },
        Setting {
            key: "mouse_capture",
            help: "Let arterm handle the mouse (scroll, click, drag-select).",
            values: BOOL,
            read: |c| bool_str(c.display.mouse_capture),
            write: |c, v| parse_bool(v).map(|b| c.display.mouse_capture = b).is_some(),
        },
    ]
}

/// Look one setting up by its key.
pub fn setting(key: &str) -> Option<&'static Setting> {
    display_settings().iter().find(|s| s.key == key)
}

/// Write one setting to `~/.arterm/config.toml` and make the running TUI use it.
///
/// Reload-patch-save rather than serializing this process's cached config, so a
/// concurrent edit from another session survives.
pub fn apply(key: &str, value: &str) -> anyhow::Result<()> {
    let setting =
        setting(key).ok_or_else(|| anyhow::anyhow!("{key} is not an editable display setting"))?;
    if !setting.values.contains(&value) {
        anyhow::bail!("{value} is not a legal value for {key}");
    }

    let mut config = Config::load();
    if !(setting.write)(&mut config, value) {
        anyhow::bail!("{value} could not be written to {key}");
    }
    config.save()?;

    // `theme` decides the palette, which is installed once rather than read per
    // frame. Everything else in this catalog is read from the live config at
    // render time and needs no reinstall.
    if key == "theme" {
        crate::tui::theme_detect::init_palette();
    }
    Ok(())
}

fn bool_str(value: bool) -> String {
    if value { "true" } else { "false" }.to_string()
}

fn parse_bool(value: &str) -> Option<bool> {
    match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_reads_back_a_value_it_offers() {
        let config = Config::default();
        for setting in display_settings() {
            let current = setting.current(&config);
            assert!(
                setting.values.contains(&current.as_str()),
                "{}'s default {current:?} is not one of {:?}",
                setting.key,
                setting.values
            );
        }
    }

    #[test]
    fn every_setting_round_trips_every_value() {
        for setting in display_settings() {
            for value in setting.values {
                let mut config = Config::default();
                assert!(
                    (setting.write)(&mut config, value),
                    "{} rejected its own value {value}",
                    setting.key
                );
                assert_eq!(
                    setting.current(&config),
                    *value,
                    "{} did not read back what was written",
                    setting.key
                );
            }
        }
    }

    #[test]
    fn a_value_outside_the_catalog_is_refused() {
        let mut config = Config::default();
        let centered = setting("centered").expect("centered is in the catalog");
        assert!(!(centered.write)(&mut config, "yes"));
        let diagram = setting("diagram_mode").expect("diagram_mode is in the catalog");
        assert!(!(diagram.write)(&mut config, "sideways"));
    }

    #[test]
    fn auto_theme_is_the_empty_string_on_disk() {
        let mut config = Config::default();
        let theme = setting("theme").expect("theme is in the catalog");
        assert!((theme.write)(&mut config, "dark"));
        assert_eq!(config.display.theme, "dark");
        assert!((theme.write)(&mut config, "auto"));
        assert_eq!(
            config.display.theme, "",
            "auto is the absence of a setting, not the word"
        );
        assert_eq!(theme.current(&config), "auto");
    }

    #[test]
    fn the_current_index_points_at_the_current_value() {
        let mut config = Config::default();
        let notes = setting("recent_notes").expect("recent_notes is in the catalog");
        assert!((notes.write)(&mut config, "5"));
        assert_eq!(notes.current_index(&config), 5);
    }

    #[test]
    fn a_hand_edited_value_outside_the_catalog_selects_the_first_option() {
        let mut config = Config::default();
        config.display.recent_notes = 42;
        let notes = setting("recent_notes").expect("recent_notes is in the catalog");
        assert_eq!(notes.current(&config), "42");
        assert_eq!(
            notes.current_index(&config),
            0,
            "an unknown value must not index out of bounds"
        );
    }

    #[test]
    fn keys_are_unique() {
        let mut keys: Vec<&str> = display_settings().iter().map(|s| s.key).collect();
        keys.sort_unstable();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count, "duplicate setting keys");
    }
}
