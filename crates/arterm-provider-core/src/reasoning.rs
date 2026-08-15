//! Shared reasoning-effort ladders.
//!
//! Keep these in provider-core so provider runtimes and UI clients expose the
//! same ordered values. `swarm` and `swarm-deep` are Arterm UI sentinels rather
//! than wire-level provider values, but they belong in the selectable ladder.

/// OpenAI Responses API effort levels, followed by Arterm's swarm modes.
pub const OPENAI_SELECTABLE_EFFORTS: &[&str] = &[
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "swarm",
    "swarm-deep",
];

/// OpenRouter's unified reasoning effort levels.
///
/// OpenRouter currently treats `max` as an alias for `xhigh`, so it is not a
/// separate rung in this ladder.
pub const OPENROUTER_SELECTABLE_EFFORTS: &[&str] = &[
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "swarm",
    "swarm-deep",
];

/// xAI Grok effort levels, followed by Arterm's swarm modes.
///
/// The set is what xAI's own models endpoint advertises for grok-4.x:
/// low/medium/high/xhigh with a high default — no `minimal`, and `xhigh` is
/// already the top rung, so there is no separate `max`.
pub const GROK_SELECTABLE_EFFORTS: &[&str] = &[
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "swarm",
    "swarm-deep",
];

/// Direct DeepSeek effort levels, followed by Arterm's swarm modes.
pub const DEEPSEEK_SELECTABLE_EFFORTS: &[&str] = &[
    "none",
    "low",
    "medium",
    "high",
    "max",
    "swarm",
    "swarm-deep",
];

/// Convert a provider-advertised OpenAI/OpenRouter effort into the canonical
/// static value used by the provider trait.
pub fn canonical_reasoning_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// Infer the selectable effort ladder when only provider/model identity is
/// available, such as in a remote TUI session.
pub fn inferred_reasoning_efforts(
    provider_name: Option<&str>,
    model_name: Option<&str>,
) -> Vec<&'static str> {
    let provider = provider_name.unwrap_or_default().to_ascii_lowercase();
    let model = model_name.unwrap_or_default().to_ascii_lowercase();

    if provider.contains("openrouter") {
        return OPENROUTER_SELECTABLE_EFFORTS.to_vec();
    }

    if provider.contains("deepseek") || model.contains("deepseek") {
        return DEEPSEEK_SELECTABLE_EFFORTS.to_vec();
    }

    // Model identity, not provider identity: an xAI session reaches here as a
    // plain openai-compatible provider, and before this arm the remote TUI
    // inferred an empty ladder for grok-4.6 — the effort keys were dead in
    // exactly the sessions the server-side grok gate had just fixed.
    if provider.contains("xai") || model.contains("grok") {
        return GROK_SELECTABLE_EFFORTS.to_vec();
    }

    // Same shape as the Grok arm, and for the same reason: a z.ai session
    // reaches here as `zai` or `openai-compatible:zai`, neither of which the
    // openai-compatible gate below accepts for a non-GPT model, so the ladder
    // came back empty and the effort keys answered "not available" on
    // glm-5.2. z.ai serves OpenAI's own vocabulary -- live-verified: an
    // out-of-range value is rejected with "reasoning_effort must be one of:
    // none, minimal, low, medium, high, xhigh, max".
    if provider.contains("zai") || model.contains("glm") {
        return OPENAI_SELECTABLE_EFFORTS.to_vec();
    }

    let is_openai_model = model.starts_with("gpt-")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.starts_with("o5");
    if provider.contains("openai-compatible") {
        return if is_openai_model {
            OPENAI_SELECTABLE_EFFORTS.to_vec()
        } else {
            Vec::new()
        };
    }

    let is_anthropic = provider.contains("anthropic")
        || provider.contains("claude")
        || model.starts_with("claude-");
    if is_anthropic {
        let caps = crate::anthropic_reasoning_caps(&model);
        if !caps.supports_reasoning_effort() {
            return Vec::new();
        }
        let mut efforts = vec!["none", "low", "medium", "high"];
        if caps.xhigh_effort {
            efforts.push("xhigh");
        }
        if caps.max_effort {
            efforts.push("max");
        }
        efforts.extend(["swarm", "swarm-deep"]);
        return efforts;
    }

    let is_openai = provider.contains("openai") || provider.contains("codex") || is_openai_model;
    if is_openai {
        return OPENAI_SELECTABLE_EFFORTS.to_vec();
    }

    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ladders_preserve_distinct_max_semantics() {
        assert_eq!(
            inferred_reasoning_efforts(Some("openai"), Some("gpt-5.4")),
            OPENAI_SELECTABLE_EFFORTS
        );
        assert!(OPENAI_SELECTABLE_EFFORTS.contains(&"max"));
        assert!(OPENAI_SELECTABLE_EFFORTS.contains(&"minimal"));
        assert!(OPENROUTER_SELECTABLE_EFFORTS.contains(&"minimal"));
        assert!(!OPENROUTER_SELECTABLE_EFFORTS.contains(&"max"));
        assert!(DEEPSEEK_SELECTABLE_EFFORTS.contains(&"max"));
        assert_eq!(
            inferred_reasoning_efforts(Some("openai-compatible:custom"), Some("gpt-5.6")),
            OPENAI_SELECTABLE_EFFORTS,
            "direct OpenAI-compatible runtimes use the OpenAI reasoning_effort vocabulary"
        );
    }

    #[test]
    fn grok_ladder_is_inferred_from_model_identity() {
        // A remote xAI session reports a plain openai-compatible provider, so
        // the model name has to carry the family; an empty ladder here is how
        // the effort keys went dead on grok-4.6 while the server supported it.
        assert_eq!(
            inferred_reasoning_efforts(Some("openai-compatible:custom"), Some("grok-4.6")),
            GROK_SELECTABLE_EFFORTS
        );
        assert_eq!(
            inferred_reasoning_efforts(Some("xai"), Some("grok-4.5")),
            GROK_SELECTABLE_EFFORTS
        );
        assert!(!GROK_SELECTABLE_EFFORTS.contains(&"max"));
        assert!(!GROK_SELECTABLE_EFFORTS.contains(&"minimal"));
    }

    #[test]
    fn glm_ladder_is_inferred_from_model_identity() {
        // z.ai reports either a bare `zai` provider or openai-compatible:zai;
        // both used to fall through to an empty ladder because glm-5.2 is not
        // a GPT-family model, which is how the effort keys went dead on GLM.
        assert_eq!(
            inferred_reasoning_efforts(Some("zai"), Some("glm-5.2")),
            OPENAI_SELECTABLE_EFFORTS
        );
        assert_eq!(
            inferred_reasoning_efforts(Some("openai-compatible:zai"), Some("glm-5.2")),
            OPENAI_SELECTABLE_EFFORTS
        );
        // Prefixed ids from gateways serving the family reach the same rung.
        assert_eq!(
            inferred_reasoning_efforts(Some("openai-compatible:custom"), Some("z-ai/glm-4.7")),
            OPENAI_SELECTABLE_EFFORTS
        );
    }

    #[test]
    fn anthropic_ladder_comes_from_model_capabilities() {
        assert_eq!(
            inferred_reasoning_efforts(Some("anthropic"), Some("claude-sonnet-4-6")),
            vec![
                "none",
                "low",
                "medium",
                "high",
                "max",
                "swarm",
                "swarm-deep"
            ]
        );
        assert_eq!(
            inferred_reasoning_efforts(Some("anthropic"), Some("claude-opus-4-7")),
            vec![
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "swarm",
                "swarm-deep"
            ]
        );
    }
}
