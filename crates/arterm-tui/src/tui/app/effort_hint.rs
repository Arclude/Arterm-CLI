//! Which reasoning effort a remote session is starting from, and the
//! provider/model identity that answer depends on.
//!
//! Split out of `tui_state.rs` for size: that file is over the oversized-file
//! ratchet's threshold and may not grow. The reasoning lives on the functions.

use crate::tui::app::App;

impl App {
    /// Provider/model identity used for reasoning-effort UI decisions in remote
    /// mode. Prefers the server-reported values, falling back to the same hints
    /// the header uses (session stub, `ARTERM_MODEL`, config default) so effort
    /// cycling works during the pre-History bootstrap window instead of
    /// reporting "not available" until the server payload settles.
    pub(in crate::tui::app) fn remote_effort_identity(&self) -> (Option<String>, Option<String>) {
        let model = self.effective_remote_provider_model();
        let provider = self.remote_provider_name.clone().or_else(|| {
            model
                .as_deref()
                .and_then(|model| {
                    crate::provider::provider_for_model_with_hint(model, None).map(str::to_string)
                })
                .or_else(|| self.configured_remote_provider_hint())
        });
        (provider, model)
    }

    /// Best-known current reasoning effort for the remote session. Falls back
    /// to the configured provider-family default when the server has not
    /// reported one yet, so pre-settle effort cycling starts from the value the
    /// session will actually use instead of assuming the maximum.
    ///
    /// Every family whose ladder `inferred_reasoning_efforts` can infer needs a
    /// starting point here too. Without one the caller treats the top rung as
    /// current and a single key press jumps straight to swarm-deep -- the
    /// ladder alone is only half the fix.
    pub(in crate::tui::app) fn remote_reasoning_effort_hint(&self) -> Option<String> {
        self.remote_reasoning_effort.clone().or_else(|| {
            let (provider, model) = self.remote_effort_identity();
            let provider = provider.unwrap_or_default().to_ascii_lowercase();
            let model = model.unwrap_or_default().to_ascii_lowercase();
            let cfg = &crate::config::config().provider;
            if provider.contains("anthropic")
                || provider.contains("claude")
                || model.starts_with("claude-")
            {
                cfg.anthropic_reasoning_effort.clone()
            } else if provider.contains("openai")
                || provider.contains("codex")
                || provider.contains("xai")
                || provider.contains("zai")
                || model.starts_with("gpt-")
                || model.contains("grok")
                || model.contains("glm")
            {
                // xAI and z.ai both ride the OpenAI runtime, which seeds its
                // effort from `openai_reasoning_effort` like any other
                // openai-compatible session.
                cfg.openai_reasoning_effort.clone()
            } else {
                None
            }
        })
    }
}
