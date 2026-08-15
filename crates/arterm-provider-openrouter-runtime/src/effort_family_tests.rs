//! Reasoning effort across the provider families that speak a
//! `reasoning_effort` dialect: xAI's Grok and z.ai's GLM.
//!
//! Kept out of `openrouter_tests.rs` because that file is already over the
//! oversized-test ratchet's threshold, and the rule there is that such files
//! may not grow. One file for both families rather than one each: `lib.rs` is
//! over the oversized-file ratchet too, so it may not gain a second `mod` line.

use super::*;
use crate::tests::{make_custom_compatible_provider, spawn_single_response_chat_server};
use futures::StreamExt;
use std::time::Duration;

#[test]
fn direct_grok_model_exposes_xhigh_reasoning_effort() {
    // grok-4.6's own catalog advertises low/medium/high/xhigh (default high);
    // before the grok family branch this provider exposed no efforts at all
    // and the effort keys were dead on an xAI session.
    let provider = OpenRouterProvider {
        model: Arc::new(RwLock::new("grok-4.6".to_string())),
        ..make_custom_compatible_provider()
    };

    assert_eq!(
        provider.available_efforts(),
        vec![
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "swarm",
            "swarm-deep"
        ]
    );
    provider
        .set_reasoning_effort("xhigh")
        .expect("Grok models should accept xhigh effort");
    assert_eq!(provider.reasoning_effort().as_deref(), Some("xhigh"));

    // "max" rides the non-deepseek/openai acceptance branch and clamps to
    // Grok's top rung; "minimal" is rejected with the available ladder.
    provider
        .set_reasoning_effort("max")
        .expect("max should clamp, not fail");
    assert_eq!(provider.reasoning_effort().as_deref(), Some("xhigh"));
    let err = provider
        .set_reasoning_effort("minimal")
        .expect_err("minimal is not a Grok effort");
    assert!(err.to_string().contains("available:"), "{err}");
}

#[test]
fn direct_grok_chat_request_sends_reasoning_effort() {
    let (api_base, request_rx) = spawn_single_response_chat_server();
    let provider = OpenRouterProvider {
        api_base,
        model: Arc::new(RwLock::new("grok-4.6".to_string())),
        supports_model_catalog: false,
        ..make_custom_compatible_provider()
    };
    provider
        .set_reasoning_effort("xhigh")
        .expect("Grok models should accept xhigh effort");

    let messages = vec![Message {
        role: Role::User,
        content: vec![ContentBlock::Text {
            text: "hello".to_string(),
            cache_control: None,
        }],
        timestamp: None,
        tool_duration_ms: None,
    }];

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
            event.expect("stream event should parse");
        }
    });

    let request = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("capture fake provider request");
    assert!(
        request.contains(r#""model":"grok-4.6""#),
        "request should contain model: {request}"
    );
    assert!(
        request.contains(r#""reasoning_effort":"xhigh""#),
        "Grok request should include the effort field: {request}"
    );
}

#[test]
fn direct_glm_model_exposes_the_openai_effort_ladder() {
    // z.ai rejects an out-of-range effort with "reasoning_effort must be one
    // of: none, minimal, low, medium, high, xhigh, max" -- OpenAI's own
    // vocabulary, live-verified. Before the GLM branch this provider exposed
    // no efforts at all and the effort keys were dead on a GLM session.
    let provider = OpenRouterProvider {
        model: Arc::new(RwLock::new("glm-5.2".to_string())),
        ..make_custom_compatible_provider()
    };

    assert_eq!(
        provider.available_efforts(),
        arterm_provider_core::OPENAI_SELECTABLE_EFFORTS.to_vec()
    );
    for effort in ["minimal", "low", "medium", "high", "xhigh", "max"] {
        provider
            .set_reasoning_effort(effort)
            .unwrap_or_else(|err| panic!("GLM should accept {effort}: {err}"));
        assert_eq!(provider.reasoning_effort().as_deref(), Some(effort));
    }
}

#[test]
fn gateway_prefixed_glm_ids_reach_the_same_ladder() {
    // Gateways serve the family under prefixed ids; matching on `contains`
    // keeps those sessions from falling back to an empty ladder.
    let provider = OpenRouterProvider {
        model: Arc::new(RwLock::new("z-ai/glm-4.7".to_string())),
        ..make_custom_compatible_provider()
    };

    assert_eq!(
        provider.available_efforts(),
        arterm_provider_core::OPENAI_SELECTABLE_EFFORTS.to_vec()
    );
}

#[test]
fn direct_glm_chat_request_sends_reasoning_effort() {
    let (api_base, request_rx) = spawn_single_response_chat_server();
    let provider = OpenRouterProvider {
        api_base,
        model: Arc::new(RwLock::new("glm-5.2".to_string())),
        supports_model_catalog: false,
        ..make_custom_compatible_provider()
    };
    provider
        .set_reasoning_effort("high")
        .expect("GLM models should accept high effort");

    let messages = vec![Message {
        role: Role::User,
        content: vec![ContentBlock::Text {
            text: "hello".to_string(),
            cache_control: None,
        }],
        timestamp: None,
        tool_duration_ms: None,
    }];

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
            event.expect("stream event should parse");
        }
    });

    let request = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("capture fake provider request");
    assert!(
        request.contains(r#""model":"glm-5.2""#),
        "request should contain model: {request}"
    );
    assert!(
        request.contains(r#""reasoning_effort":"high""#),
        "GLM request should include the effort field: {request}"
    );
}
