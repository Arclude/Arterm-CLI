//! When to try again, and how long to wait.
//!
//! The waiting is **ours**, never a vendor SDK's. An SDK that obeys
//! `Retry-After` verbatim turns a one-hour rate limit into a one-hour sleep
//! *inside* the provider, where the fallback chain cannot see it and the user
//! sees a turn that simply never ends. So every adapter disables the SDK's own
//! retry loop and asks this module instead.

use std::time::Duration;

/// Backoff schedule and its ceilings.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// The longest a server-supplied `Retry-After` is honored.
    ///
    /// Beyond it the wait is refused rather than clamped-and-slept: a limit
    /// measured in hours is not something to wait out inside one request, it is
    /// a reason to fall back to another provider now. The cap also bounds a
    /// hostile or malformed upstream, which can otherwise stall a turn by
    /// naming any number it likes.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 4,
            initial_backoff: Duration::from_secs(2),
            max_backoff: Duration::from_secs(60),
            max_retry_after: Duration::from_secs(60),
        }
    }
}

/// Spread a backoff by ±20%.
///
/// Pure, so the policy crate stays dependency-free and the schedule stays
/// testable; the caller supplies the random factor. It matters during a
/// *correlated* outage, which is the only time many retries are in flight at
/// once: without it every session that failed together also retries together,
/// and the recovering server is hit by the same thundering herd on each round.
pub fn jitter(backoff: Duration, factor: f64) -> Duration {
    let clamped = factor.clamp(0.8, 1.2);
    let millis = (backoff.as_millis() as f64 * clamped) as u64;
    Duration::from_millis(millis.max(1))
}

/// What to do after a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecision {
    /// Wait this long, then send the same request again.
    After(Duration),
    /// Stop retrying — attempts are spent, or the wait is too long to be worth
    /// sitting through.
    GiveUp,
}

impl RetryPolicy {
    /// Decide what happens after `attempt` (1-based) failed.
    ///
    /// A server-supplied wait wins over the computed backoff when it is shorter
    /// than the ceiling — the server knows when its window resets and we do
    /// not. Past the ceiling the answer is [`RetryDecision::GiveUp`], which is
    /// what lets the fallback chain engage while the turn is still alive.
    pub fn decide(&self, attempt: u32, retry_after: Option<Duration>) -> RetryDecision {
        if attempt >= self.max_attempts {
            return RetryDecision::GiveUp;
        }
        if let Some(wait) = retry_after {
            if wait > self.max_retry_after {
                return RetryDecision::GiveUp;
            }
            return RetryDecision::After(wait);
        }
        // Exponential, capped: 2s, 4s, 8s, … up to max_backoff.
        let exponent = attempt.saturating_sub(1).min(16);
        let backoff = self
            .initial_backoff
            .saturating_mul(2u32.saturating_pow(exponent))
            .min(self.max_backoff);
        RetryDecision::After(backoff)
    }
}

/// Read a `Retry-After` header.
///
/// The header carries either a count of seconds or an HTTP date; both forms are
/// in the wild, and a parser that handles only one silently loses the wait for
/// whichever provider uses the other.
pub fn parse_retry_after(value: &str, now_unix: i64) -> Option<Duration> {
    let trimmed = value.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let target = httpdate_to_unix(trimmed)?;
    // A date already in the past means "retry now", not a negative wait.
    Some(Duration::from_secs(target.saturating_sub(now_unix).max(0) as u64))
}

/// Minimal IMF-fixdate parser (`Sun, 06 Nov 1994 08:49:37 GMT`), the only form
/// `Retry-After` is specified to use.
fn httpdate_to_unix(value: &str) -> Option<i64> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let mut hms = parts[4].split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let minute: i64 = hms.next()?.parse().ok()?;
    let second: i64 = hms.next()?.parse().ok()?;

    // Days from the civil epoch (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_then_stops_growing() {
        let policy = RetryPolicy { max_attempts: 10, ..Default::default() };
        assert_eq!(policy.decide(1, None), RetryDecision::After(Duration::from_secs(2)));
        assert_eq!(policy.decide(2, None), RetryDecision::After(Duration::from_secs(4)));
        assert_eq!(policy.decide(3, None), RetryDecision::After(Duration::from_secs(8)));
        // Capped rather than doubling into the next hour.
        assert_eq!(policy.decide(9, None), RetryDecision::After(Duration::from_secs(60)));
    }

    #[test]
    fn attempts_run_out() {
        let policy = RetryPolicy { max_attempts: 3, ..Default::default() };
        assert_eq!(policy.decide(3, None), RetryDecision::GiveUp);
    }

    #[test]
    fn a_short_server_wait_is_honored_over_our_own_backoff() {
        let policy = RetryPolicy::default();
        assert_eq!(
            policy.decide(1, Some(Duration::from_secs(5))),
            RetryDecision::After(Duration::from_secs(5))
        );
    }

    #[test]
    fn jitter_spreads_a_herd_without_leaving_the_band() {
        let base = Duration::from_secs(10);
        assert_eq!(jitter(base, 0.8), Duration::from_secs(8));
        assert_eq!(jitter(base, 1.2), Duration::from_secs(12));
        // A caller passing something outside the band is clamped, not obeyed:
        // a 10x factor would turn a 60s cap into ten minutes.
        assert_eq!(jitter(base, 10.0), Duration::from_secs(12));
        assert_eq!(jitter(base, 0.0), Duration::from_secs(8));
    }

    #[test]
    fn jitter_never_collapses_a_wait_to_nothing() {
        // Zero would turn a backoff into a hot loop against a failing server.
        assert!(jitter(Duration::from_millis(1), 0.8) >= Duration::from_millis(1));
    }

    #[test]
    fn an_hour_long_wait_is_refused_so_the_fallback_chain_can_run() {
        // This is the whole reason the ceiling exists: obeying it verbatim
        // parks the turn inside the provider, invisible to every layer above.
        let policy = RetryPolicy::default();
        assert_eq!(policy.decide(1, Some(Duration::from_secs(3600))), RetryDecision::GiveUp);
    }

    #[test]
    fn retry_after_parses_both_wire_forms() {
        assert_eq!(parse_retry_after("30", 0), Some(Duration::from_secs(30)));
        // 1994-11-06T08:49:37Z = 784111777
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_717),
            Some(Duration::from_secs(60))
        );
    }

    #[test]
    fn a_date_in_the_past_means_retry_now() {
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_900),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn garbage_is_no_wait_rather_than_a_wrong_one() {
        assert_eq!(parse_retry_after("soon", 0), None);
    }
}
