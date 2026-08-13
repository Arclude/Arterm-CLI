//! Which credential an OpenAI-compatible profile presents, when xAI's Grok
//! subscription is in the picture. Split from `lib.rs` for size alone; the
//! reasoning lives on the functions.

use crate::ProviderAuth;
use arterm_base::provider_catalog::load_api_key_from_env_or_config;

/// The Grok-subscription bearer, when `api_key_env` is xAI's and a login is on
/// disk. One function rather than a rule repeated at each construction site:
/// five separate sites answered "does xAI have credentials" with an api-key
/// lookup, and each one independently made a working login look absent.
pub(crate) fn xai_subscription_auth(api_key_env: &str) -> Option<ProviderAuth> {
    if api_key_env != "XAI_API_KEY" {
        return None;
    }
    let tokens = arterm_base::auth::xai::stored_tokens()?;
    if tokens.access_token.is_empty() {
        return None;
    }
    Some(ProviderAuth::AuthorizationBearer {
        token: tokens.access_token,
        label: "Grok subscription".to_string(),
    })
}

/// The credential a profile presents: the signed-in subscription when there is
/// one, the API key otherwise. The subscription wins because it is the one
/// somebody deliberately signed in to use -- the reverse order is what produced
/// `Incorrect API key provided` from `/v1/models` while a good token sat on
/// disk. The stored token is used as-is; an expired one surfaces as a 401 that
/// the refresh path already handles, which beats a blocking refresh inside a
/// catalog poll.
pub(crate) fn profile_auth(
    resolved: &arterm_base::provider_catalog::ResolvedOpenAiCompatibleProfile,
) -> Option<ProviderAuth> {
    if let Some(auth) = xai_subscription_auth(&resolved.api_key_env) {
        return Some(auth);
    }
    load_api_key_from_env_or_config(&resolved.api_key_env, &resolved.env_file).map(|key| {
        ProviderAuth::AuthorizationBearer {
            token: key,
            label: resolved.api_key_env.clone(),
        }
    })
}
