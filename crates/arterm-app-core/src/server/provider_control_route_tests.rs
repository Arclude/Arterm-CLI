//! The locked-room regression: an explicit route switch must escape a
//! provider with no models. In its own file so the main test module stays
//! inside the size budget.

use super::*;
use crate::message::{Message, ToolDefinition};
use crate::provider::{EventStream, ModelRoute, Provider};
use crate::tool::Registry;
use async_trait::async_trait;
use std::sync::Mutex as StdMutex;

/// A session stranded on a credential-less provider has an empty
/// `available_models_for_switching`, and the old guard turned that into a
/// locked room: an explicit route selection -- which names its complete
/// destination and asks nothing of the current provider -- was refused with
/// "Model switching is not available". Recovering from a dead provider is the
/// one moment a route switch matters most.
#[tokio::test]
async fn a_route_switch_escapes_a_provider_with_no_models() {
    #[derive(Default)]
    struct StrandedProvider {
        selected: StdMutex<Option<String>>,
    }

    #[async_trait]
    impl Provider for StrandedProvider {
        async fn complete(
            &self,
            _messages: &[Message],
            _tools: &[ToolDefinition],
            _system: &str,
            _resume_session_id: Option<&str>,
        ) -> anyhow::Result<EventStream> {
            anyhow::bail!("not used in this test")
        }
        fn name(&self) -> &str {
            "stranded"
        }
        fn model(&self) -> String {
            self.selected
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "dead-model".to_string())
        }
        fn fork(&self) -> Arc<dyn Provider> {
            Arc::new(Self::default())
        }
        // The stranded state: nothing to switch to *within* this provider.
        fn available_models_for_switching(&self) -> Vec<String> {
            Vec::new()
        }
        fn set_model(&self, model: &str) -> anyhow::Result<()> {
            *self.selected.lock().unwrap() = Some(model.to_string());
            Ok(())
        }
        fn model_routes(&self) -> Vec<ModelRoute> {
            vec![ModelRoute {
                model: "grok-4.6".to_string(),
                provider: "xAI".to_string(),
                api_method: "api key".to_string(),
                available: true,
                detail: String::new(),
                cheapness: None,
            }]
        }
    }

    let provider: Arc<dyn Provider> = Arc::new(StrandedProvider::default());
    let agent = Arc::new(Mutex::new(Agent::new(provider, Registry::empty())));
    let (client_event_tx, mut client_event_rx) = mpsc::unbounded_channel();

    handle_set_route(
        7,
        crate::provider::RouteSelection {
            model: "grok-4.6".to_string(),
            provider_label: "xAI".to_string(),
            api_method: "api key".to_string(),
            detail: String::new(),
            runtime_key: arterm_provider_core::RuntimeKey::OpenAiCompatible {
                profile_id: Some("xai".to_string()),
            },
        },
        &agent,
        &client_event_tx,
    )
    .await;

    let event = client_event_rx.recv().await.expect("a ModelChanged event");
    match event {
        ServerEvent::ModelChanged { model, error, .. } => {
            assert_eq!(
                error, None,
                "an explicit route must not be refused for the current provider's emptiness"
            );
            // The agent reports the routed form; the destination is what matters.
            assert!(
                model.ends_with("grok-4.6"),
                "switched to the wrong place: {model}"
            );
        }
        other => panic!("expected ModelChanged, got {other:?}"),
    }
}
