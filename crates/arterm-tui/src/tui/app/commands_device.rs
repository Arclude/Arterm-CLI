//! `/device` — the whole pairing flow, on one screen.
//!
//! Everything this command needs already existed as `arterm device invite`,
//! `listen` and `join`, in that order, across two terminals. What was missing
//! was not capability but a place to do it: three commands that each had to be
//! run somewhere specific, in an order nothing told you, with a token carried
//! between them.
//!
//! Opening this screen is the whole flow now. The keys are deliberately few —
//! arrows, digits, Enter, Esc — because the screen is shown to someone standing
//! at a second computer, reading a code off the first.

use crossterm::event::KeyCode;

use super::{App, DisplayMessage};
use crate::tui::device_pairing::DevicePairing;

pub(crate) const USAGE: &str = "Usage: /device";

/// Handle `/device`, returning whether the input was ours.
pub(crate) fn handle_device_command(app: &mut App, trimmed: &str) -> bool {
    let Some(rest) = trimmed
        .strip_prefix("/device")
        .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
    else {
        return false;
    };

    // Subcommands are what this screen replaces, so an argument is more likely
    // a habit from the CLI than a request. Say what the screen does instead of
    // failing silently.
    if !rest.trim().is_empty() {
        app.push_display_message(DisplayMessage::system(format!(
            "`/device` opens the pairing screen — pairing, codes and paired \
             machines are all on it.\n\n{USAGE}"
        )));
        return true;
    }

    match DevicePairing::open() {
        Ok(screen) => {
            app.device_pairing = Some(Box::new(screen));
            app.set_status_notice("Devices");
        }
        Err(error) => {
            app.push_display_message(DisplayMessage::error(format!(
                "Could not open the pairing screen: {error:#}"
            )));
        }
    }
    true
}

/// A key while the pairing screen is up, returning whether it was consumed.
///
/// Called from both key dispatch paths. There are two — the local one and the
/// remote one — and a modal wired into only one of them draws but does not
/// answer, which is a state that looks like a frozen screen.
pub(crate) fn handle_pairing_key(app: &mut App, code: KeyCode) -> bool {
    let Some(screen) = app.device_pairing.as_mut() else {
        return false;
    };

    match code {
        KeyCode::Up => screen.move_selection(-1),
        KeyCode::Down => screen.move_selection(1),
        KeyCode::Enter => {
            screen.activate();
        }
        KeyCode::Backspace => {
            screen.pop_digit();
        }
        KeyCode::Char(digit) if digit.is_ascii_digit() => {
            screen.push_digit(digit);
        }
        KeyCode::Esc => {
            // Escape backs out one step at a time: the code being typed first,
            // the screen second. Closing on the first Esc would throw away a
            // half-typed code someone is still reading off the other machine.
            if !screen.cancel_entry() {
                app.device_pairing = None;
                app.set_status_notice("Devices closed");
            }
        }
        // Anything else is left alone rather than swallowed, so a key the
        // screen has no use for still reaches whatever does.
        _ => return false,
    }
    true
}

impl App {
    /// Tick hook: refresh the list while the screen is open.
    ///
    /// Machines appear and disappear as they open and close their own screens,
    /// so this is what makes the list live rather than a snapshot from the
    /// moment it opened. Returns true when something changed.
    pub(crate) fn poll_device_pairing(&mut self) -> bool {
        let Some(screen) = self.device_pairing.as_mut() else {
            return false;
        };
        screen.tick()
    }
}

#[cfg(test)]
#[path = "commands_device_tests.rs"]
mod commands_device_tests;
