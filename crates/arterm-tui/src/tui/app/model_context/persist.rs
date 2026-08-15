//! Remembering the model the user chose, so the next launch opens on it.
//! Split from `model_context.rs` for size alone; the reasoning lives on the
//! functions.

use crate::tui::app::{App, DisplayMessage};

impl App {
    /// A switch the user asked for by name: land it, then remember it as the
    /// startup default. Closing arterm on one model and reopening on another
    /// was a standing complaint -- the choice lived only in the session.
    /// Failover and onboarding auto-selection keep calling
    /// `finalize_model_switch` directly: an automatic escape to a fallback
    /// provider must not rewrite what the user chose.
    pub(in crate::tui::app) fn finalize_user_model_switch(
        &mut self,
        model_request: &str,
    ) -> String {
        let active_model = self.finalize_model_switch(model_request);
        let provider_key = self.session.provider_key.clone();
        self.persist_startup_model_choice(&active_model, provider_key.as_deref());
        active_model
    }

    /// The remote twin, called from the `ModelChanged` success arm. It also
    /// retires the in-flight marker (the error arm drops it directly), and it
    /// persists only when BOTH hold:
    /// - this client requested the switch -- an unsolicited change (another
    ///   client, a server-side failover) must not rewrite the user's choice;
    /// - no fallback resend is pending -- the Ctrl+Y escape from a failing
    ///   provider answers one message, it does not choose a startup default.
    pub(in crate::tui::app) fn remember_model_choice(
        &mut self,
        model: &str,
        provider_name: Option<&str>,
    ) {
        let user_requested_switch =
            std::mem::replace(&mut self.remote_model_switch_in_flight, false);
        if !user_requested_switch || self.pending_fallback_resend.is_some() {
            return;
        }
        let provider_key = crate::provider::MultiProvider::session_provider_key_after_model_switch(
            model,
            provider_name.unwrap_or(""),
            self.session.provider_key.as_deref(),
        );
        self.persist_startup_model_choice(model, provider_key.as_deref());
    }

    fn persist_startup_model_choice(&mut self, model: &str, provider_key: Option<&str>) {
        let result = match provider_key {
            Some(key) => crate::config::Config::set_default_model(Some(model), Some(key)),
            None => crate::config::Config::set_default_model_only(Some(model)),
        };
        if let Err(error) = result {
            self.push_display_message(DisplayMessage::error(format!(
                "Switched, but could not save {} as the startup default: {}",
                model, error
            )));
        }
    }
}
