//! Integration discovery: shared constants and provenance tracking.
//!
//! Integration discovery makes third-party developer tools discoverable to
//! the agent through the `discover_tools` tool, backed by a hosted manifest.
//! All agent-facing guidance lives in that tool's schema rather than the
//! system prompt.
//! Some providers may share revenue with Arterm when users choose their tools.
//! Partnership status never influences recommendations. The relationship is
//! disclosed in the UI with a link to <https://arterm.sh/discovery-tools>.
//!
//! Design constraints (see the discovery-tools page for the public
//! version of this policy):
//! - Solo Systems vets every listing and enforces one-tool-call setup at the
//!   sponsor-platform admission layer for seamless harness integration. That
//!   vetting is upstream's, and so is the endpoint — which is why the next
//!   line reads the way it does in this fork.
//! - Discovery is **off** by default and must be opted into with
//!   `[sponsors] enabled = true` in config.toml. The requests below carry the
//!   model's `query` and `reason`, i.e. what the user is building, to a host
//!   nobody here operates; see `SponsorsConfig` for the full argument.
//! - The category list below is a shipped constant, so building the tool schema
//!   never requires a network request.
//! - Tools within a category live server-side and are fetched on demand by
//!   `discover_tools`. If the request fails, the tool fails plainly. There is
//!   no cache and no offline fallback.
//! - Requests carry only discovery fields (category, query, tool, and reason),
//!   never session content.

/// Public URL explaining Arterm's tool-provider partnerships.
pub const DISCOVERY_PARTNERS_URL: &str = "https://arterm.sh/discovery-tools";

pub use arterm_config_types::{DEFAULT_DISCOVERY_ENDPOINT, LEGACY_DISCOVERY_ENDPOINT};

/// Say, once at boot, that discovery is enabled against an endpoint that came
/// from a shipped default rather than from anyone here.
///
/// It REPORTS rather than corrects, the same call `config_file.rs` documents
/// where the old repair used to live: a `true` we did not write cannot be told
/// from one the user meant, so rewriting it would be the removed mistake
/// pointing the other way. What is left is the gap that made the mistake
/// tempting — an enabled default is otherwise completely silent, and what
/// crosses it is the model's own description of what is being built.
///
/// Two conditions, each carrying its weight:
/// - **Enabled**, because a disabled endpoint is never contacted and a warning
///   about something that cannot happen is one people learn to scroll past.
/// - **A DEFAULT endpoint**, because an operator who set their own host has
///   already answered this question, and repeating it after the decision is
///   the same noise. This is the `contextWindowNote` rule: fire only for the
///   untouched shipped value, since config merging keeps no provenance.
pub fn discovery_endpoint_note(enabled: bool, endpoint: &str) -> Option<String> {
    if !enabled {
        return None;
    }
    let trimmed = endpoint.trim_end_matches('/');
    if trimmed != DEFAULT_DISCOVERY_ENDPOINT && trimmed != LEGACY_DISCOVERY_ENDPOINT {
        return None;
    }
    Some(format!(
        "integration discovery is ON and points at {trimmed}, which is upstream's endpoint and is \
         not operated by this fork. `discover_tools` sends the model's own query and reason — a \
         description of what you are building — to that host. Set `[sponsors] enabled = false` in \
         config.toml to turn it off, or `endpoint` to a directory you trust."
    ))
}

/// Provenance tagging and coarse usage metering for MCP servers connected
/// as a result of a discovery listing.
pub mod provenance;

/// Categories in which discoverable tools exist. Shipped as a constant so the
/// tool schema never depends on the network. The tools within each category are
/// served by the discovery endpoint.
pub const DISCOVERY_CATEGORIES: &[&str] = &[
    "payments",
    "code-review",
    "databases",
    "browser-automation",
    "deployment",
    "observability",
    "authentication",
    "security",
    "storage",
    "analytics",
    "web-search",
    "web-data",
    "financial-data",
    "cloud-infrastructure",
    "compliance-and-privacy",
    "integration-platforms",
    "email-messaging",
    "ai-models",
    "other",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_are_nonempty_and_lowercase() {
        assert!(!DISCOVERY_CATEGORIES.is_empty());
        for cat in DISCOVERY_CATEGORIES {
            assert!(!cat.is_empty());
            assert_eq!(cat.to_ascii_lowercase(), *cat);
            assert!(!cat.contains(' '), "categories are slugs: {cat}");
        }
    }

    #[test]
    fn categories_match_the_public_discovery_taxonomy() {
        assert_eq!(
            DISCOVERY_CATEGORIES,
            &[
                "payments",
                "code-review",
                "databases",
                "browser-automation",
                "deployment",
                "observability",
                "authentication",
                "security",
                "storage",
                "analytics",
                "web-search",
                "web-data",
                "financial-data",
                "cloud-infrastructure",
                "compliance-and-privacy",
                "integration-platforms",
                "email-messaging",
                "ai-models",
                "other",
            ]
        );
    }

    #[test]
    fn discovery_is_disabled_by_default() {
        let config = crate::config::Config::default();
        assert!(
            !config.sponsors.enabled,
            "the default endpoint is not ours; discovery must be opt-in"
        );
    }

    #[test]
    fn the_note_fires_only_for_an_enabled_default_endpoint() {
        // Enabled against the endpoint we inherited: the case worth saying out
        // loud, because nothing else on screen would mention it.
        let note = discovery_endpoint_note(true, DEFAULT_DISCOVERY_ENDPOINT);
        let note = note.expect("an enabled default endpoint is worth reporting");
        assert!(
            note.contains(DEFAULT_DISCOVERY_ENDPOINT),
            "the note must name the host it is about: {note}"
        );

        // Disabled: nothing is contacted, so there is nothing to report.
        assert!(discovery_endpoint_note(false, DEFAULT_DISCOVERY_ENDPOINT).is_none());

        // Enabled against an endpoint the user chose: they configured it, and a
        // warning that repeats after the decision is one people learn to skip.
        assert!(discovery_endpoint_note(true, "https://discovery.internal/v1").is_none());
    }
}
