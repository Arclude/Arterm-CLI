//! Which reasoning-effort dialect the active model speaks: the family
//! detectors, the support gates, and each family's normalizer. Split from
//! `lib.rs` for size alone; the reasoning lives on the functions.

use crate::OpenRouterProvider;

impl OpenRouterProvider {
    fn profile_supports_reasoning_effort(profile_id: Option<&str>) -> bool {
        matches!(profile_id, Some(id) if id.eq_ignore_ascii_case("deepseek"))
    }

    /// DeepSeek-family models accept the DeepSeek-style top-level
    /// `reasoning_effort` request field regardless of which OpenAI-compatible
    /// gateway serves them (issue #352: profiles like opencode-go serve
    /// DeepSeek V4 but were rejected by the profile-id-only check).
    pub(crate) fn model_is_deepseek_family(model: &str) -> bool {
        model.trim().to_ascii_lowercase().contains("deepseek")
    }

    /// Does this runtime accept the DeepSeek-style `reasoning_effort` field?
    /// Priority: explicit named-profile config override, then the dedicated
    /// deepseek profile, then the active model family for direct compat
    /// endpoints (never for real OpenRouter, which uses unified reasoning).
    pub(crate) fn supports_deepseek_reasoning_effort(&self) -> bool {
        if let Some(explicit) = self.reasoning_effort_support {
            return explicit;
        }
        if Self::profile_supports_reasoning_effort(self.profile_id.as_deref()) {
            return true;
        }
        !Self::profile_supports_unified_reasoning(
            self.profile_id.as_deref(),
            self.send_openrouter_headers,
        ) && Self::model_is_deepseek_family(&self.model_snapshot())
    }

    /// GPT-family reasoning models (gpt-5.x, codex variants, o-series) accept
    /// the standard OpenAI `reasoning_effort` request field on any
    /// OpenAI-compatible gateway that proxies them (e.g. OpenCode Zen serving
    /// `gpt-5.3-codex-spark`). Real OpenRouter uses unified reasoning instead.
    fn model_is_openai_reasoning_family(model: &str) -> bool {
        let model = model.trim().to_ascii_lowercase();
        model.starts_with("gpt-5")
            || model.contains("codex")
            || model.starts_with("o1")
            || model.starts_with("o3")
            || model.starts_with("o4")
            || model.starts_with("o5")
    }

    /// Does this runtime accept the OpenAI-style `reasoning_effort` field for
    /// the active model? Only for direct compat endpoints serving GPT-family
    /// reasoning models, and only when no explicit config override or
    /// DeepSeek-style support already applies.
    pub(crate) fn supports_openai_reasoning_effort(&self) -> bool {
        if self.reasoning_effort_support == Some(false) {
            return false;
        }
        !Self::profile_supports_unified_reasoning(
            self.profile_id.as_deref(),
            self.send_openrouter_headers,
        ) && Self::model_is_openai_reasoning_family(&self.model_snapshot())
    }

    /// Grok models take the standard `reasoning_effort` field on xAI's own
    /// endpoint — live-verified against grok-4.6, whose catalog advertises
    /// low/medium/high/xhigh with a high default. `contains` rather than
    /// `starts_with` for the same reason as DeepSeek (issue #352): gateways
    /// serve the family under prefixed ids like `x-ai/grok-4.6`.
    fn model_is_grok_family(model: &str) -> bool {
        model.trim().to_ascii_lowercase().contains("grok")
    }

    /// Does this runtime accept the `reasoning_effort` field for a Grok
    /// model? Only on direct compat endpoints (real OpenRouter uses unified
    /// reasoning), and an explicit config override still wins.
    pub(crate) fn supports_grok_reasoning_effort(&self) -> bool {
        if self.reasoning_effort_support == Some(false) {
            return false;
        }
        !Self::profile_supports_unified_reasoning(
            self.profile_id.as_deref(),
            self.send_openrouter_headers,
        ) && Self::model_is_grok_family(&self.model_snapshot())
    }

    fn model_snapshot(&self) -> String {
        self.model
            .try_read()
            .map(|model| model.clone())
            .unwrap_or_default()
    }

    pub(crate) fn supports_any_reasoning_effort(&self) -> bool {
        self.supports_deepseek_reasoning_effort()
            || self.supports_openai_reasoning_effort()
            || self.supports_grok_reasoning_effort()
            || Self::profile_supports_unified_reasoning(
                self.profile_id.as_deref(),
                self.send_openrouter_headers,
            )
    }

    pub(crate) fn normalize_reasoning_effort_for_self(&self, effort: &str) -> Option<String> {
        if self.supports_deepseek_reasoning_effort() {
            Self::normalize_reasoning_effort(effort)
        } else if self.supports_openai_reasoning_effort() {
            Self::normalize_openai_reasoning_effort(effort)
        } else if self.supports_grok_reasoning_effort() {
            Self::normalize_grok_reasoning_effort(effort)
        } else {
            Self::normalize_unified_reasoning_effort(effort)
        }
    }

    /// Initial reasoning effort at construction. Named/compat profiles that
    /// support effort honor the user's configured `openai_reasoning_effort`
    /// (issue #352: previously hardcoded to None so the config was ignored).
    pub(crate) fn initial_reasoning_effort(
        reasoning_effort_support: Option<bool>,
        profile_id: Option<&str>,
    ) -> Option<String> {
        let supported =
            reasoning_effort_support.unwrap_or(Self::profile_supports_reasoning_effort(profile_id));
        if !supported {
            return None;
        }
        arterm_base::config::config()
            .provider
            .openai_reasoning_effort
            .as_deref()
            .and_then(Self::normalize_reasoning_effort)
    }

    pub(crate) fn profile_supports_unified_reasoning(
        profile_id: Option<&str>,
        send_openrouter_headers: bool,
    ) -> bool {
        // Real OpenRouter uses unified reasoning. The runtime may carry either
        // no profile id or the "openrouter" doctor-profile id (assigned when
        // the default api base matches the OpenRouter OpenAI-compat profile),
        // so both must qualify (issue: effort rejected on plain OpenRouter).
        send_openrouter_headers && profile_id.is_none_or(|id| id.eq_ignore_ascii_case("openrouter"))
    }

    fn normalize_reasoning_effort(raw: &str) -> Option<String> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        match value.as_str() {
            "none" | "low" | "medium" | "high" | "max" | "swarm" | "swarm-deep" => Some(value),
            // Match the existing OpenAI UX: accept unknown non-empty effort values
            // by snapping to the strongest setting instead of rejecting the command.
            other => {
                arterm_base::logging::info(&format!(
                    "Warning: Ignoring unsupported DeepSeek reasoning effort '{}'; expected none|low|medium|high|max.",
                    other
                ));
                None
            }
        }
    }

    fn normalize_openai_reasoning_effort(raw: &str) -> Option<String> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        match value.as_str() {
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "swarm"
            | "swarm-deep" => Some(value),
            other => {
                arterm_base::logging::info(&format!(
                    "Warning: Ignoring unsupported OpenAI-compatible reasoning effort '{}'.",
                    other
                ));
                None
            }
        }
    }

    fn normalize_grok_reasoning_effort(raw: &str) -> Option<String> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        match value.as_str() {
            "none" | "low" | "medium" | "high" | "xhigh" | "swarm" | "swarm-deep" => Some(value),
            // Grok's ladder tops out at xhigh and starts at low, so the
            // neighbors from other families snap to the nearest rung instead
            // of rejecting an effort the user meant.
            "max" => Some("xhigh".to_string()),
            "minimal" => Some("low".to_string()),
            other => {
                arterm_base::logging::info(&format!(
                    "Warning: Ignoring unsupported Grok reasoning effort '{}'; expected none|low|medium|high|xhigh.",
                    other
                ));
                None
            }
        }
    }

    fn normalize_unified_reasoning_effort(raw: &str) -> Option<String> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        match value.as_str() {
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "swarm" | "swarm-deep" => {
                Some(value)
            }
            "max" => Some("xhigh".to_string()),
            other => {
                arterm_base::logging::info(&format!(
                    "Warning: Ignoring unsupported OpenRouter reasoning effort '{}'; expected none|minimal|low|medium|high|xhigh|max alias.",
                    other
                ));
                None
            }
        }
    }
}
