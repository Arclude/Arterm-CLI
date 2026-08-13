//! Signing in to xAI with a Grok subscription instead of an API key.
//!
//! xAI runs a public OIDC provider at `https://auth.x.ai` whose discovery
//! document advertises the device-code grant, PKCE (`S256`), and
//! `token_endpoint_auth_methods_supported: ["none"]` -- a public client, so
//! there is no secret to keep. A SuperGrok or X Premium+ subscription is what
//! the `grok-cli:access` scope is granted against; a free account authenticates
//! and comes back without it, which is a case worth reporting rather than
//! discovering later as a 401 mid-turn.
//!
//! # Why the device flow is the default here
//!
//! The shared client's redirect URI is registered to one fixed loopback port.
//! That is fine until the port is taken -- by a second arterm, by the editor's
//! own Grok integration -- and unlike our other flows we cannot simply pick
//! another port, because the authorization server will reject a redirect it was
//! not registered with. The device flow has no redirect at all, works over SSH,
//! and costs the user one paste. So it leads, and the loopback flow is the
//! fallback rather than the other way round.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// xAI's shared OAuth client for coding agents.
///
/// Public metadata, not a credential: the discovery document lists `none` among
/// its accepted client authentication methods, and xAI's own announcements point
/// third-party agents at this flow. The consent screen therefore names xAI's
/// Grok client rather than Arterm, which is worth saying out loud in the login
/// prompt so nobody reads it as the wrong app asking.
pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";

pub const ISSUER: &str = "https://auth.x.ai";
pub const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
pub const AUTHORIZE_URL: &str = "https://auth.x.ai/oauth2/authorize";
pub const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";

/// `offline_access` is what makes this a login rather than a session: without it
/// the response carries no refresh token and the user is back here in an hour.
pub const SCOPES: &str = "openid profile email offline_access grok-cli:access api:access \
     conversations:read conversations:write workspaces:read workspaces:write";

/// The scope that actually buys model access. Present only on a subscription.
pub const SUBSCRIPTION_SCOPE: &str = "grok-cli:access";

/// The one loopback port the shared client is registered for.
pub const REDIRECT_PORT: u16 = 56121;

/// The `referrer` xAI's own client sends with a device-code request.
pub const REFERRER: &str = "grok-build";

/// Surfaces xAI's client distinguishes: a human reading a TUI, a CLI on a tty,
/// or something with nobody to complete the approval.
pub const SURFACE_UI: &str = "ui";
pub const SURFACE_CLI: &str = "cli";

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}/callback")
}

/// Tokens as stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct XaiTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix seconds. Compared against `now` with a skew allowance rather than
    /// used bare -- see [`needs_refresh`].
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub scopes: Vec<String>,
}

impl XaiTokens {
    /// Whether the subscription scope came back. A free Grok account completes
    /// the login and lands here without it.
    pub fn has_subscription_access(&self) -> bool {
        self.scopes.iter().any(|scope| scope == SUBSCRIPTION_SCOPE)
    }
}

/// Refresh this long before the token actually expires.
///
/// A token that expires between the check and the request arriving is a 401 the
/// user reads as "it logged me out again". The provider layer also retries on
/// 401, but a predictable refresh is cheaper than a failed turn.
const REFRESH_SKEW: i64 = 300;

/// Whether `tokens` should be refreshed before the next request.
pub fn needs_refresh(tokens: &XaiTokens, now: i64) -> bool {
    if tokens.access_token.is_empty() {
        return true;
    }
    // No expiry recorded is treated as expired rather than as forever: an
    // unknown lifetime that we guess "valid" fails at request time instead.
    if tokens.expires_at == 0 {
        return true;
    }
    tokens.expires_at - REFRESH_SKEW <= now
}

pub fn tokens_path() -> Result<std::path::PathBuf> {
    Ok(crate::storage::arterm_dir()?.join("xai_oauth.json"))
}

pub fn load_tokens() -> Result<XaiTokens> {
    let path = tokens_path()?;
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("No xAI login found at {}", path.display()))?;
    serde_json::from_str(&raw).context("xAI credentials file is not valid JSON")
}

pub fn has_tokens() -> bool {
    tokens_path().is_ok_and(|path| path.exists())
}

pub fn save_tokens(tokens: &XaiTokens) -> Result<()> {
    let path = tokens_path()?;
    // The same owner-only writer every other credential file here uses; a
    // refresh token is a long-lived credential and must not land world-readable.
    crate::storage::write_json_secret(&path, tokens)
}

/// The stored login, or None -- with the two None cases kept distinct: a
/// missing file is simply "not signed in", but a file that exists and does not
/// parse is a broken credential store, and reading it as "not signed in" would
/// silently log the user out. That case warns.
pub fn stored_tokens() -> Option<XaiTokens> {
    if !has_tokens() {
        return None;
    }
    match load_tokens() {
        Ok(tokens) => Some(tokens),
        Err(error) => {
            arterm_logging::warn(&format!(
                "xAI credentials file exists but could not be read: {error}"
            ));
            None
        }
    }
}

/// The login state as the auth inventory reports it.
pub fn auth_state() -> crate::auth::AuthState {
    if has_tokens() {
        crate::auth::AuthState::Available
    } else {
        crate::auth::AuthState::NotConfigured
    }
}

pub fn logout() -> Result<bool> {
    let path = tokens_path()?;
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)?;
    Ok(true)
}

/// What the device endpoint hands back, minus the fields nothing reads.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCodeGrant {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    #[serde(default = "default_expires_in")]
    pub expires_in: i64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_expires_in() -> i64 {
    600
}

/// RFC 8628 says five seconds when the server does not say otherwise.
fn default_interval() -> u64 {
    5
}

impl DeviceCodeGrant {
    /// The URL to show. Prefer the one with the code already in it -- it is the
    /// difference between the user typing an eight-character code correctly and
    /// not.
    pub fn best_url(&self) -> &str {
        self.verification_uri_complete
            .as_deref()
            .unwrap_or(&self.verification_uri)
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_secs(self.interval.clamp(1, 60))
    }
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_in: i64,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Where a poll stands. `authorization_pending` and `slow_down` are not
/// failures; treating them as such is the classic way to break a device flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    /// The server asked us to back off; the caller widens its interval.
    SlowDown,
    Approved(Box<XaiTokens>),
    Denied(String),
    Expired,
}

/// Turn a token-endpoint response into an outcome.
///
/// Split out from the request so the state machine is testable without a
/// network: every branch here is a real response shape from RFC 8628 §3.5.
pub fn classify_token_response(status: u16, body: &str, now: i64) -> Result<PollOutcome> {
    if (200..300).contains(&status) {
        let parsed: TokenResponse =
            serde_json::from_str(body).context("xAI token response was not valid JSON")?;
        if parsed.access_token.is_empty() {
            bail!("xAI returned an empty access token");
        }
        return Ok(PollOutcome::Approved(Box::new(XaiTokens {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
            expires_at: now + parsed.expires_in.max(0),
            scopes: parsed
                .scope
                .as_deref()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect(),
        })));
    }

    let Ok(parsed) = serde_json::from_str::<TokenError>(body) else {
        bail!("xAI login failed ({status}): {body}");
    };
    Ok(match parsed.error.as_str() {
        "authorization_pending" => PollOutcome::Pending,
        "slow_down" => PollOutcome::SlowDown,
        "expired_token" => PollOutcome::Expired,
        "access_denied" => PollOutcome::Denied(
            parsed
                .error_description
                .unwrap_or_else(|| "You declined the request in the browser.".to_string()),
        ),
        other => bail!(
            "xAI login failed: {other}{}",
            match parsed.error_description {
                Some(detail) => format!(" ({detail})"),
                None => String::new(),
            }
        ),
    })
}

/// Ask xAI for a device code to show the user.
pub async fn request_device_code(surface: &'static str) -> Result<DeviceCodeGrant> {
    let client = crate::provider::shared_http_client();
    let response = client
        .post(DEVICE_CODE_URL)
        // `referrer` and the two headers are what xAI's own client sends; they
        // segment its device-flow funnel metrics. Sent honestly -- our surface
        // and our version, not theirs.
        .header("x-grok-client-surface", surface)
        .header("x-grok-client-version", arterm_build_meta::VERSION)
        .form(&[
            ("client_id", CLIENT_ID),
            ("scope", SCOPES),
            ("referrer", REFERRER),
        ])
        .send()
        .await
        .context("Could not reach xAI to start the login")?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .context("Could not read xAI's device-code response")?;
    if status == 404 {
        bail!(
            "xAI's device login is not enabled for this client. Set XAI_API_KEY to use a metered key instead."
        );
    }
    if !(200..300).contains(&status) {
        bail!("xAI refused to start the login ({status}): {body}");
    }
    let grant: DeviceCodeGrant = serde_json::from_str(&body)
        .context("xAI's device-code response was not the expected shape")?;
    // The code is printed to a terminal and copied to the clipboard, so a
    // control character in it would be acted on rather than shown.
    if !grant
        .user_code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        bail!("xAI returned a device code with unexpected characters; refusing to display it.");
    }
    Ok(grant)
}

/// Poll until the user approves, declines, or the code expires.
///
/// The interval widens on `slow_down` and never narrows: an authorization
/// server that asks for room and is ignored starts refusing outright.
pub async fn poll_for_tokens(grant: &DeviceCodeGrant) -> Result<XaiTokens> {
    let client = crate::provider::shared_http_client();
    let mut interval = grant.poll_interval();
    let deadline =
        std::time::Instant::now() + Duration::from_secs(grant.expires_in.clamp(60, 1800) as u64);

    loop {
        if std::time::Instant::now() >= deadline {
            bail!("The xAI login code expired before it was approved. Run the command again.");
        }
        tokio::time::sleep(interval).await;

        let response = client
            .post(TOKEN_URL)
            .header("x-grok-client-version", arterm_build_meta::VERSION)
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", grant.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .context("Lost contact with xAI while waiting for approval")?;

        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .context("Lost contact with xAI while reading the poll response")?;
        match classify_token_response(status, &body, now_unix())? {
            PollOutcome::Pending => {}
            PollOutcome::SlowDown => interval += Duration::from_secs(5),
            PollOutcome::Approved(tokens) => return Ok(*tokens),
            PollOutcome::Denied(reason) => bail!("xAI login declined: {reason}"),
            PollOutcome::Expired => {
                bail!("The xAI login code expired before it was approved. Run the command again.")
            }
        }
    }
}

/// Exchange a refresh token for a fresh access token.
///
/// xAI rotates refresh tokens, so a response that omits one means "keep the one
/// you have" -- overwriting it with an empty string would log the user out at
/// the next refresh instead.
pub async fn refresh_tokens(current: &XaiTokens) -> Result<XaiTokens> {
    if current.refresh_token.is_empty() {
        bail!("This xAI login has no refresh token; sign in again with `arterm login xai`.");
    }
    let client = crate::provider::shared_http_client();
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh_token.as_str()),
        ])
        .send()
        .await
        .context("Could not reach xAI to refresh the login")?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .context("Could not read xAI's refresh response")?;
    let PollOutcome::Approved(mut refreshed) = classify_token_response(status, &body, now_unix())?
    else {
        bail!("xAI would not refresh this login; sign in again with `arterm login xai`.");
    };
    if refreshed.refresh_token.is_empty() {
        refreshed.refresh_token = current.refresh_token.clone();
    }
    if refreshed.scopes.is_empty() {
        refreshed.scopes = current.scopes.clone();
    }
    save_tokens(&refreshed)?;
    Ok(*refreshed)
}

/// The stored login, refreshed first when it is close to expiring.
pub async fn load_or_refresh_tokens() -> Result<XaiTokens> {
    let tokens = load_tokens()?;
    if needs_refresh(&tokens, now_unix()) {
        return refresh_tokens(&tokens).await;
    }
    Ok(tokens)
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Run the whole device flow: request a code, show it, wait for approval.
///
/// `announce` receives the instructions so the caller decides where they go --
/// stdout for `arterm login`, a transcript message for `/login`.
pub async fn login(surface: &'static str, announce: impl FnOnce(&str)) -> Result<XaiTokens> {
    let grant = request_device_code(surface).await?;
    announce(&approval_instructions(&grant));
    let tokens = poll_for_tokens(&grant).await?;
    save_tokens(&tokens)?;
    Ok(tokens)
}

/// The message shown while the user approves in a browser.
///
/// Names xAI's client explicitly: the consent screen says Grok, not Arterm,
/// because this is xAI's shared client for coding agents, and a login screen
/// naming an app you did not open is exactly what a phishing page looks like.
pub fn approval_instructions(grant: &DeviceCodeGrant) -> String {
    format!(
        "Sign in to xAI with your Grok subscription\n\n  \
         1. Open {}\n  \
         2. Enter the code: {}\n\n\
         The consent screen is xAI's own (it names their Grok client, not Arterm) \
         because xAI publishes one shared OAuth client for coding agents.\n\
         Waiting for approval\u{2026}",
        grant.best_url(),
        grant.user_code
    )
}

/// What to tell someone whose login worked but whose plan does not include API
/// access.
pub fn missing_subscription_notice() -> &'static str {
    "Signed in to xAI, but this account did not grant `grok-cli:access`. \
     That scope comes with a SuperGrok or X Premium+ subscription; a free Grok \
     account can sign in but cannot call the API. Either upgrade the plan, or \
     set XAI_API_KEY to use a metered key instead."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scope_set_asks_for_a_refresh_token() {
        assert!(
            SCOPES.split_whitespace().any(|s| s == "offline_access"),
            "without offline_access this is a session, not a login"
        );
        assert!(SCOPES.split_whitespace().any(|s| s == SUBSCRIPTION_SCOPE));
    }

    #[test]
    fn the_redirect_uri_is_the_one_port_the_shared_client_registered() {
        assert_eq!(redirect_uri(), "http://127.0.0.1:56121/callback");
    }

    /// The three RFC 8628 non-failures. Treating any of them as an error is the
    /// classic way to break a device flow: the first poll always returns
    /// `authorization_pending`, because the user has not touched the browser yet.
    #[test]
    fn a_pending_approval_is_not_a_failure() {
        let pending = classify_token_response(400, r#"{"error":"authorization_pending"}"#, 0)
            .expect("pending is a normal response");
        assert_eq!(pending, PollOutcome::Pending);

        let slow = classify_token_response(400, r#"{"error":"slow_down"}"#, 0).expect("slow_down");
        assert_eq!(slow, PollOutcome::SlowDown);

        let expired =
            classify_token_response(400, r#"{"error":"expired_token"}"#, 0).expect("expired");
        assert_eq!(expired, PollOutcome::Expired);
    }

    #[test]
    fn a_declined_request_says_so_rather_than_looking_like_a_bug() {
        let outcome = classify_token_response(
            400,
            r#"{"error":"access_denied","error_description":"User rejected"}"#,
            0,
        )
        .expect("access_denied is a classified outcome");
        assert_eq!(outcome, PollOutcome::Denied("User rejected".to_string()));
    }

    #[test]
    fn an_approval_records_the_expiry_as_an_instant_not_a_duration() {
        let body = r#"{"access_token":"at","refresh_token":"rt","expires_in":3600,
                       "scope":"openid grok-cli:access"}"#;
        let outcome = classify_token_response(200, body, 1_000).expect("approved");
        let PollOutcome::Approved(tokens) = outcome else {
            panic!("expected approval, got {outcome:?}");
        };
        assert_eq!(tokens.access_token, "at");
        assert_eq!(tokens.refresh_token, "rt");
        assert_eq!(tokens.expires_at, 4_600, "expires_in is relative to now");
        assert!(tokens.has_subscription_access());
    }

    /// A free account completes the flow and comes back without the scope. That
    /// has to be visible at login, not as a 401 three prompts later.
    #[test]
    fn a_login_without_the_subscription_scope_is_detectable() {
        let body = r#"{"access_token":"at","expires_in":3600,"scope":"openid profile"}"#;
        let PollOutcome::Approved(tokens) =
            classify_token_response(200, body, 0).expect("approved")
        else {
            panic!("expected approval");
        };
        assert!(!tokens.has_subscription_access());
        assert!(missing_subscription_notice().contains("SuperGrok"));
    }

    #[test]
    fn an_empty_access_token_is_refused_rather_than_stored() {
        let err = classify_token_response(200, r#"{"access_token":""}"#, 0)
            .expect_err("an empty token must not be accepted");
        assert!(err.to_string().contains("empty access token"));
    }

    #[test]
    fn an_unrecognized_error_surfaces_its_description() {
        let err = classify_token_response(
            400,
            r#"{"error":"invalid_client","error_description":"unknown client"}"#,
            0,
        )
        .expect_err("invalid_client is fatal");
        let text = err.to_string();
        assert!(text.contains("invalid_client"), "{text}");
        assert!(text.contains("unknown client"), "{text}");
    }

    #[test]
    fn refresh_happens_before_the_token_actually_dies() {
        let fresh = XaiTokens {
            access_token: "at".to_string(),
            expires_at: 10_000,
            ..Default::default()
        };
        assert!(!needs_refresh(&fresh, 9_000));
        // Inside the skew window: refresh now rather than race the request.
        assert!(needs_refresh(&fresh, 9_800));
        assert!(needs_refresh(&fresh, 10_001));
    }

    /// Unknown beats optimistic: a file with no expiry recorded would otherwise
    /// be treated as valid forever and fail at request time instead.
    #[test]
    fn tokens_with_no_recorded_expiry_are_refreshed() {
        let unknown = XaiTokens {
            access_token: "at".to_string(),
            expires_at: 0,
            ..Default::default()
        };
        assert!(needs_refresh(&unknown, 0));

        let empty = XaiTokens::default();
        assert!(needs_refresh(&empty, 0));
    }

    #[test]
    fn the_code_is_shown_with_a_url_that_already_carries_it_when_offered() {
        let mut grant = DeviceCodeGrant {
            device_code: "dc".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            verification_uri: "https://x.ai/device".to_string(),
            verification_uri_complete: None,
            expires_in: 600,
            interval: 5,
        };
        assert_eq!(grant.best_url(), "https://x.ai/device");
        grant.verification_uri_complete = Some("https://x.ai/device?code=ABCD-EFGH".to_string());
        assert_eq!(grant.best_url(), "https://x.ai/device?code=ABCD-EFGH");

        let text = approval_instructions(&grant);
        assert!(text.contains("ABCD-EFGH"), "{text}");
        assert!(text.contains("?code=ABCD-EFGH"), "{text}");
        assert!(
            text.contains("not Arterm"),
            "the prompt must explain whose consent screen this is: {text}"
        );
    }

    /// RFC 8628's default, and a server that omits it must not produce a
    /// zero-second busy loop against xAI.
    #[test]
    fn a_missing_poll_interval_falls_back_to_the_spec_default() {
        let grant: DeviceCodeGrant = serde_json::from_str(
            r#"{"device_code":"dc","user_code":"UC","verification_uri":"https://x.ai/device"}"#,
        )
        .expect("a minimal device grant should parse");
        assert_eq!(grant.interval, 5);
        assert_eq!(grant.poll_interval(), Duration::from_secs(5));
        assert_eq!(grant.expires_in, 600);
    }

    #[test]
    fn an_absurd_poll_interval_is_clamped() {
        let mut grant: DeviceCodeGrant = serde_json::from_str(
            r#"{"device_code":"dc","user_code":"UC","verification_uri":"u","interval":0}"#,
        )
        .expect("parse");
        assert_eq!(grant.poll_interval(), Duration::from_secs(1));
        grant.interval = 9_999;
        assert_eq!(grant.poll_interval(), Duration::from_secs(60));
    }
}
