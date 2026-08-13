// The Grok-subscription /login wiring; its own include so the reload test
// file stays inside the size budget.

/// `/login` must offer the Grok subscription and, when it is chosen, start the
/// device flow rather than the API-key prompt.
///
/// The two share a `LoginProviderTarget`, so dispatching on the target alone
/// sends this one to the key prompt -- which is what it did before the id
/// check, and it looks like a working login until you notice it is asking for
/// a key you signed in to avoid.
#[test]
fn the_grok_subscription_login_is_offered_and_starts_the_device_flow() {
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let _guard = runtime.enter();

    let offered = crate::provider_catalog::tui_login_providers();
    let provider = offered
        .iter()
        .find(|p| p.id == crate::provider_catalog::XAI_OAUTH_LOGIN_PROVIDER.id)
        .copied()
        .expect("/login should offer the Grok subscription");

    let mut app = create_test_app();
    app.start_login_provider(provider);

    let rendered = app
        .display_messages()
        .iter()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        rendered.contains("device code"),
        "choosing it should start the device flow, got: {rendered}"
    );
    assert!(
        !rendered.to_lowercase().contains("api key"),
        "it must not fall through to the API-key prompt: {rendered}"
    );
}
