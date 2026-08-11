//! Classifying a provider failure.
//!
//! The classification is not cosmetic: it decides whether the request is
//! retried, whether the fallback chain engages, and whether the turn is lost.
//! Getting it wrong is how a recoverable rate limit ends a run.

use std::fmt;

/// What kind of failure this is, from the caller's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorKind {
    /// Credentials are missing, wrong, or expired. Retrying cannot help; a
    /// different account or provider might.
    Auth,
    /// Rate limited or out of quota. Retryable after a wait, and the single
    /// most important case for the fallback chain.
    Quota,
    /// The request itself is malformed or unsupported. Never retried — the same
    /// bytes fail the same way.
    BadRequest,
    /// The server broke (5xx). Retryable.
    Server,
    /// The connection broke. Retryable.
    Transport,
    /// Anything unrecognized. Treated as non-retryable, because retrying an
    /// unknown failure forever is worse than surfacing it.
    Unknown,
}

impl ProviderErrorKind {
    /// Whether sending the same request again could plausibly succeed.
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Quota | Self::Server | Self::Transport)
    }

    /// Whether a different provider or account should be tried.
    ///
    /// Wider than `is_retryable`: an auth failure will never fix itself here,
    /// but the next entry in the chain may well be fine.
    pub fn should_fall_back(self) -> bool {
        matches!(self, Self::Auth | Self::Quota | Self::Server | Self::Transport)
    }
}

#[derive(Debug, Clone)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub status: Option<u16>,
    pub message: String,
    /// Seconds to wait, when the server said so.
    pub retry_after_secs: Option<u64>,
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.status {
            Some(status) => write!(f, "provider error {status}: {}", self.message),
            None => write!(f, "provider error: {}", self.message),
        }
    }
}

impl std::error::Error for ProviderError {}

/// Words a provider uses when the account is out of budget.
///
/// This exists because the status code alone lies. Anthropic answers an
/// exhausted usage budget with **400**, which reads as "your request is
/// malformed" — a non-retryable class that stops the fallback chain before it
/// starts. The turn is then lost to a condition another provider could have
/// served. So the body is consulted before the code is trusted.
const QUOTA_PHRASES: &[&str] = &[
    "usage limit",
    "usage_limit",
    "rate limit",
    "rate_limit",
    "quota",
    "insufficient_quota",
    "out of credit",
    "credit balance",
    "billing",
    "exceeded your current",
];

/// Classify a failed response from its status code and body.
pub fn classify(status: u16, body: &str) -> ProviderErrorKind {
    let lowered = body.to_ascii_lowercase();
    let looks_like_quota = QUOTA_PHRASES.iter().any(|p| lowered.contains(p));

    match status {
        429 => ProviderErrorKind::Quota,
        401 | 403 => {
            // A 403 whose body talks about budget is a quota problem wearing a
            // permissions status code.
            if looks_like_quota { ProviderErrorKind::Quota } else { ProviderErrorKind::Auth }
        }
        400..=499 => {
            if looks_like_quota { ProviderErrorKind::Quota } else { ProviderErrorKind::BadRequest }
        }
        500..=599 => ProviderErrorKind::Server,
        _ => ProviderErrorKind::Unknown,
    }
}

/// Whether a transport-level failure is worth retrying.
///
/// Matched on the message because the concrete error type belongs to whichever
/// HTTP client the adapter uses, and this crate deliberately depends on none.
pub fn is_transient_transport_error(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    [
        "connection reset",
        "connection refused",
        "connection closed",
        "broken pipe",
        "timed out",
        "timeout",
        "temporarily unavailable",
        "eof while parsing",
        "unexpected end of file",
        "stream closed",
        "dns error",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quota_400_is_not_read_as_a_malformed_request() {
        // The measured case: an exhausted budget answered with 400. Classified
        // as BadRequest it is non-retryable AND skips the fallback chain, so
        // the turn dies on a condition the next provider could have served.
        let kind = classify(400, r#"{"error":{"message":"You have exhausted your usage limit"}}"#);
        assert_eq!(kind, ProviderErrorKind::Quota);
        assert!(kind.should_fall_back());
    }

    #[test]
    fn an_ordinary_400_stays_non_retryable() {
        let kind = classify(400, r#"{"error":{"message":"max_tokens: must be >= 1"}}"#);
        assert_eq!(kind, ProviderErrorKind::BadRequest);
        assert!(!kind.is_retryable());
        assert!(!kind.should_fall_back(), "the same request fails on every provider");
    }

    #[test]
    fn a_401_is_auth_and_still_falls_back() {
        let kind = classify(401, "invalid api key");
        assert_eq!(kind, ProviderErrorKind::Auth);
        assert!(!kind.is_retryable(), "the same key fails the same way");
        assert!(kind.should_fall_back(), "another account may be fine");
    }

    #[test]
    fn a_403_about_billing_is_quota_not_auth() {
        assert_eq!(classify(403, "credit balance is too low"), ProviderErrorKind::Quota);
    }

    #[test]
    fn server_and_transport_failures_are_retryable() {
        assert!(classify(503, "upstream unavailable").is_retryable());
        assert!(is_transient_transport_error("connection reset by peer"));
        assert!(is_transient_transport_error("error decoding response body: timed out"));
    }

    #[test]
    fn an_unrecognized_failure_is_not_retried_forever() {
        let kind = classify(999, "who knows");
        assert_eq!(kind, ProviderErrorKind::Unknown);
        assert!(!kind.is_retryable());
    }
}
