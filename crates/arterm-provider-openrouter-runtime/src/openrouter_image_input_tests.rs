//! Image input against endpoints that only take text.
//!
//! Kept out of `openrouter_tests.rs` because that file is already over the
//! oversized-test ratchet's threshold, and the rule there is that such files
//! may not grow. A new subject is a new file.

use super::*;
use crate::tests::{ENV_LOCK, EnvVarGuard};

/// A coding endpoint takes text and nothing else, and the rejection is the
/// endpoint's rather than the model's: switching models does not help, and an
/// image already in the transcript is resent with every later turn, so the
/// session never recovers on its own. Images have to be left out before the
/// request, not diagnosed after it.
#[test]
fn coding_endpoints_are_text_only() {
    for base in [
        "https://api.z.ai/api/coding/paas/v4",
        "https://api.z.ai/api/coding/paas/v4/",
        "https://api.kimi.com/coding/v1",
        "https://coding.dashscope.aliyuncs.com/compatible-mode/v1",
    ] {
        assert!(
            super::is_coding_agent_api_base(base),
            "{base} should be recognized as a text-only coding endpoint"
        );
    }

    for base in [
        "https://api.z.ai/api/paas/v4",
        "https://api.openai.com/v1",
        "http://localhost:11434/v1",
    ] {
        assert!(
            !super::is_coding_agent_api_base(base),
            "{base} is an ordinary endpoint and must keep image support"
        );
    }
}

/// The wiring, not just the predicate: a profile pointed at a coding endpoint
/// must report no image support, so `build_chat_messages` substitutes the
/// placeholder instead of a content part the endpoint rejects.
#[test]
fn a_coding_endpoint_profile_reports_no_image_support() {
    let _lock = ENV_LOCK.lock();
    let _namespace = EnvVarGuard::remove("ARTERM_OPENROUTER_CACHE_NAMESPACE");

    let profile = arterm_base::config::NamedProviderConfig {
        base_url: "https://api.z.ai/api/coding/paas/v4".to_string(),
        auth: arterm_base::config::NamedProviderAuth::None,
        default_model: Some("glm-5.2".to_string()),
        ..Default::default()
    };

    let provider = OpenRouterProvider::new_named_openai_compatible("zai-coding-test", &profile)
        .expect("named profile should initialize");

    assert!(
        !provider.supports_image_input(),
        "the coding endpoint answers an image part with HTTP 400, on every model"
    );
}
