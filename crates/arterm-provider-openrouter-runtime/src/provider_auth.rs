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
            Self::HeaderValue { label, .. } => label,
            Self::AzureEntra { label } => label,
            Self::None { label } => label,
        }
    }
}
