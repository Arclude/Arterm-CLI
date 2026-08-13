//! Named looks for the TUI, selectable with `/theme`.
//!
//! A preset is a complete set of role colors, not a diff: applying one replaces
//! `[display.colors]` wholesale so switching back and forth cannot accumulate
//! leftovers from the theme before it. `arterm` is the empty set, which is how
//! "use the built-in defaults" is spelled.
//!
//! # Where `classic` comes from
//!
//! The TypeScript CLI drew its screen with Ink and React and none of that code
//! could travel to ratatui -- but its palette could, because a palette is data.
//! `classic` is `packages/tui/src/theme.ts` as it stood at `ab57e7f^`: pinned
//! Catppuccin Mocha truecolor pastels, chosen there for a reason worth keeping:
//! a bare ANSI name resolves against the terminal's own 16-color palette, so the
//! same session looked harsh in one terminal and washed out in another, and
//! neither was a choice anybody made.
//!
//! Its semantic tokens map onto our roles rather than our role names being
//! renamed to match: `assistant` is our `ai`, `textMuted` is our `dim`,
//! `brandPrimary`/`brandAccent` are the header's name and icon.

use arterm_tui_style::palette::{ALL_ROLES, Role};
use std::collections::BTreeMap;

/// The screen shape a theme selects, separately from its colors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Look {
    /// The built-in arterm screen.
    #[default]
    Arterm,
    /// The shape the TypeScript CLI drew: a composer framed by text rails.
    Classic,
}

impl Look {
    /// The value stored in `[display] look`. The default is the empty string so
    /// a config written before this key existed reads as the built-in look.
    pub fn key(self) -> &'static str {
        match self {
            Look::Arterm => "",
            Look::Classic => "classic",
        }
    }

    fn from_key(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "classic" => Look::Classic,
            _ => Look::Arterm,
        }
    }
}

/// The look the config selects. Cheap: the config itself is cached.
pub fn current_look() -> Look {
    Look::from_key(&crate::config::config().display.look)
}

/// One selectable look.
pub struct ThemePreset {
    pub name: &'static str,
    pub summary: &'static str,
    /// `(role key, #rrggbb)`. Empty means "the built-in defaults".
    pub colors: &'static [(&'static str, &'static str)],
    /// The screen shape this theme draws.
    pub look: Look,
}

/// The built-in look: every role at its compiled-in default.
const ARTERM: ThemePreset = ThemePreset {
    name: "arterm",
    summary: "The built-in look: cool blues and greens on your terminal's own background.",
    colors: &[],
    look: Look::Arterm,
};

/// The TypeScript CLI's palette, ported token for token.
const CLASSIC: ThemePreset = ThemePreset {
    name: "classic",
    summary: "The TypeScript CLI's Catppuccin Mocha pastels, ported from packages/tui/theme.ts.",
    colors: &[
        // Speakers. TS said user=cyan, assistant=green, tool=yellow.
        ("user", "#94e2d5"),
        ("ai", "#a6e3a1"),
        ("tool", "#f9e2af"),
        // Text weights: textPrimary / textSecondary / textMuted.
        ("user_text", "#cdd6f4"),
        ("ai_text", "#bac2de"),
        ("dim", "#6c7086"),
        // Surfaces. `surfaceRaised` is the one the user's own line sat on.
        ("user_bg", "#1e1e2e"),
        ("selection_bg", "#313244"),
        // Brand: peach for the name, pink for the icon beside it.
        ("header_name", "#fab387"),
        ("header_icon", "#f5c2e7"),
        ("header_session", "#cdd6f4"),
        // Status. These are the four TS named outright.
        ("success", "#a6e3a1"),
        ("warning", "#f9e2af"),
        ("error", "#f38ba8"),
        ("info", "#89b4fa"),
        // Structure.
        ("accent", "#94e2d5"),
        ("border", "#585b70"),
        ("file_link", "#89b4fa"),
        // Queue states had no TS token of their own; these follow the same
        // Catppuccin ramp so the set stays one palette rather than two.
        ("system", "#f5c2e7"),
        ("queued", "#fab387"),
        ("asap", "#89dceb"),
        ("pending", "#585b70"),
    ],
    look: Look::Classic,
};

pub const PRESETS: &[ThemePreset] = &[ARTERM, CLASSIC];

/// The preset named `name`, if there is one.
pub fn find(name: &str) -> Option<&'static ThemePreset> {
    let name = name.trim().to_ascii_lowercase();
    PRESETS.iter().find(|preset| preset.name == name)
}

/// The preset whose colors `configured` exactly reproduces.
///
/// Inferred rather than recorded in the config, so a theme that has been
/// hand-edited since (with `/colors set`) reports itself as what it now is --
/// something of the user's own -- instead of still claiming the preset's name.
pub fn active(configured: &BTreeMap<String, String>) -> Option<&'static ThemePreset> {
    PRESETS.iter().find(|preset| matches(preset, configured))
}

fn matches(preset: &ThemePreset, configured: &BTreeMap<String, String>) -> bool {
    if preset.colors.len() != configured.len() {
        return false;
    }
    preset.colors.iter().all(|(role, hex)| {
        configured
            .get(*role)
            .is_some_and(|value| value.eq_ignore_ascii_case(hex))
    })
}

/// A preset's colors as the map `[display.colors]` stores.
pub fn color_map(preset: &ThemePreset) -> BTreeMap<String, String> {
    preset
        .colors
        .iter()
        .map(|(role, hex)| ((*role).to_string(), (*hex).to_string()))
        .collect()
}

/// Roles a preset leaves at their default, in `ALL_ROLES` order.
pub fn uncovered_roles(preset: &ThemePreset) -> Vec<Role> {
    ALL_ROLES
        .iter()
        .copied()
        .filter(|role| !preset.colors.iter().any(|(key, _)| *key == role.key()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A typo in a role key would silently do nothing: `[display.colors]` is a
    /// free-form map, so an unknown key is stored and then ignored by every
    /// reader. Nothing else in the product would report it.
    #[test]
    fn every_preset_key_is_a_real_role() {
        for preset in PRESETS {
            for (key, _) in preset.colors {
                assert!(
                    Role::from_key(key).is_some(),
                    "{}: '{key}' is not a color role",
                    preset.name
                );
            }
        }
    }

    #[test]
    fn every_preset_color_is_a_hex_triple() {
        for preset in PRESETS {
            for (key, hex) in preset.colors {
                assert!(
                    hex.len() == 7
                        && hex.starts_with('#')
                        && hex[1..].chars().all(|c| c.is_ascii_hexdigit()),
                    "{}: {key} = '{hex}' is not #rrggbb",
                    preset.name
                );
            }
        }
    }

    /// A half-covered theme is worse than none: the roles it forgot keep the
    /// previous look and the screen ends up wearing both.
    #[test]
    fn classic_covers_every_role() {
        let missing = uncovered_roles(&CLASSIC);
        assert!(
            missing.is_empty(),
            "classic leaves these roles at the arterm default: {:?}",
            missing.iter().map(|r| r.key()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_default_look_is_the_empty_set() {
        assert!(ARTERM.colors.is_empty());
        assert_eq!(uncovered_roles(&ARTERM).len(), ALL_ROLES.len());
    }

    #[test]
    fn presets_are_uniquely_named_and_lowercase() {
        let mut seen = std::collections::BTreeSet::new();
        for preset in PRESETS {
            assert_eq!(preset.name, preset.name.to_ascii_lowercase());
            assert!(seen.insert(preset.name), "duplicate preset {}", preset.name);
        }
    }

    #[test]
    fn a_preset_is_found_by_name_however_it_is_typed() {
        assert_eq!(find("classic").map(|p| p.name), Some("classic"));
        assert_eq!(find("  CLASSIC ").map(|p| p.name), Some("classic"));
        assert!(find("catppuccin").is_none());
    }

    #[test]
    fn the_active_preset_is_the_one_whose_colors_are_installed() {
        assert_eq!(active(&BTreeMap::new()).map(|p| p.name), Some("arterm"));

        let classic = color_map(&CLASSIC);
        assert_eq!(active(&classic).map(|p| p.name), Some("classic"));

        // One hand-edited role and it is no longer that preset.
        let mut edited = classic.clone();
        edited.insert("user".to_string(), "#ffffff".to_string());
        assert!(active(&edited).is_none());

        // Nor is a subset of it.
        let mut partial = color_map(&CLASSIC);
        partial.remove("border");
        assert!(active(&partial).is_none());
    }

    /// Config files are written by hand as often as by us.
    #[test]
    fn a_hex_case_difference_is_still_the_same_theme() {
        let shouted: BTreeMap<String, String> = color_map(&CLASSIC)
            .into_iter()
            .map(|(role, hex)| (role, hex.to_ascii_uppercase()))
            .collect();
        assert_eq!(active(&shouted).map(|p| p.name), Some("classic"));
    }
}
