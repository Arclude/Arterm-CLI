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

/// A tool result with an attached image (the `read` tool on a PNG) must reach
/// an image-capable direct profile as an `image_url` content part in a user
/// message after the tool message. The block order the agent produces is
/// [ToolResult, Image, Text-label] inside one user message; the builder flushes
/// the trailing parts as their own user message.
#[test]
fn tool_result_images_reach_image_capable_profiles() {
    let _lock = ENV_LOCK.lock();
    let (api_base, request_rx) = crate::tests::spawn_single_response_chat_server();
    let provider = OpenRouterProvider {
        api_base,
        profile_id: Some("xai".to_string()),
        supports_provider_features: false,
        supports_model_catalog: false,
        ..crate::tests::make_custom_compatible_provider()
    };
    assert!(provider.supports_image_input());

    let messages = vec![
        Message {
            role: Role::User,
            content: vec![ContentBlock::Text {
                text: "read the image".to_string(),
                cache_control: None,
            }],
            timestamp: None,
            tool_duration_ms: None,
        },
        Message {
            role: Role::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "call_img".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"file_path": "vision-probe.png"}),
                thought_signature: None,
            }],
            timestamp: None,
            tool_duration_ms: None,
        },
        Message {
            role: Role::User,
            content: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "call_img".to_string(),
                    content: "Read image file: vision-probe.png".to_string(),
                    is_error: None,
                },
                ContentBlock::Image {
                    media_type: "image/png".to_string(),
                    data: "aW1hZ2U=".to_string(),
                },
                ContentBlock::Text {
                    text: "[Attached image associated with the preceding tool result: vision-probe.png]"
                        .to_string(),
                    cache_control: None,
                },
            ],
            timestamp: None,
            tool_duration_ms: None,
        },
    ];

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let mut stream = provider
            .complete(&messages, &[], "", None)
            .await
            .expect("fake chat request should start");
        while let Some(event) = stream.next().await {
            if event.is_err() {
                break;
            }
        }
    });

    let request = request_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("capture fake provider request");
    assert!(
        request.contains(r#""type":"image_url""#),
        "tool-result image must be serialized as an image_url part: {request}"
    );
    assert!(
        request.contains("data:image/png;base64,aW1hZ2U="),
        "image bytes must ride along: {request}"
    );
}
