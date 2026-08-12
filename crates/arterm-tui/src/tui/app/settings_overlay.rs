//! `/config` overlay wiring: opening it, and feeding it keys.
//!
//! The overlay itself (rows, navigation, rendering) lives in
//! [`crate::tui::settings_overlay`]; this is only the App side, kept beside the
//! other overlay wiring so the key routing in both run loops has one obvious
//! counterpart.

use super::App;
impl App {
    /// Open the `/config` display-settings overlay.
    pub(in crate::tui) fn open_settings_overlay(&mut self) {
        self.settings_overlay = Some(crate::tui::settings_overlay::SettingsOverlay::new());
        self.request_full_redraw();
    }

    /// Feed one key to the settings overlay, closing it when it says so.
    pub(in crate::tui) fn handle_settings_overlay_key(
        &mut self,
        code: crossterm::event::KeyCode,
        modifiers: crossterm::event::KeyModifiers,
    ) {
        use crate::tui::settings_overlay::SettingsOutcome;
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if overlay.handle_key(code, modifiers) == SettingsOutcome::Close {
            self.settings_overlay = None;
        }
        self.request_full_redraw();
    }
}
