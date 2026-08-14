//! How a request proves who it is: the credential forms an OpenAI-compatible
//! endpoint accepts. Moved out of `lib.rs` whole; the semantics are unchanged.

use anyhow::Result;
use reqwest::header::HeaderName;

#[derive(Debug, Clone)]
pub(crate) enum ProviderAuth {
    AuthorizationBearer {
        token: String,
        label: String,
    },
    /// xAI Grok subscription login: the bearer is minted per request from the
    /// stored OAuth tokens, refreshing them first when they are stale. A
    /// frozen token here is how sessions died with 403 bad-credentials hours
    /// after login -- the refresh machinery existed but nothing on the
    /// request path called it.
    GrokSubscription {
        label: String,
    },
    HeaderValue {
        header_name: HeaderName,
        value: String,
        label: String,
    },
    AzureEntra {
        label: String,
    },
    None {
        label: String,
    },
}

impl ProviderAuth {
    pub(crate) async fn apply(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder> {
        match self {
            Self::AuthorizationBearer { token, .. } => Ok(req.bearer_auth(token)),
            Self::GrokSubscription { .. } => {
                let tokens = arterm_base::auth::xai::load_or_refresh_tokens().await?;
                Ok(req.bearer_auth(tokens.access_token))
            }
            Self::HeaderValue {
                header_name, value, ..
            } => Ok(req.header(header_name, value)),
            Self::AzureEntra { .. } => {
                let token = arterm_base::auth::azure::get_bearer_token().await?;
                Ok(req.bearer_auth(token))
            }
            Self::None { .. } => Ok(req),
        }
    }

    pub(crate) fn label(&self) -> &str {
        match self {
            Self::AuthorizationBearer { label, .. } => label,
            Self::GrokSubscription { label } => label,
            Self::HeaderValue { label, .. } => label,
            Self::AzureEntra { label } => label,
            Self::None { label } => label,
        }
    }
}
