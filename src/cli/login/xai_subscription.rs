//! `arterm login --provider xai-oauth`. Split from `login.rs` for size alone;
//! the flow itself lives in `arterm_base::auth::xai`.

use anyhow::Result;

/// The xAI device-code login, end to end.
///
/// Device code rather than a loopback redirect: xAI's shared client is
/// registered for one fixed port, so a busy port cannot be worked around by
/// choosing another -- the authorization server would reject the redirect. The
/// device flow has no redirect at all and works the same over SSH.
pub(super) async fn run_xai_subscription_login() -> Result<()> {
    use crate::auth::xai;

    let tokens = xai::login(xai::SURFACE_CLI, |instructions| {
        println!("\n{instructions}")
    })
    .await?;

    if tokens.has_subscription_access() {
        println!("\nSigned in to xAI. Arterm will use your Grok subscription for xAI models.");
    } else {
        // The login worked; the plan is what did not. Said here rather than
        // discovered as a 401 in the middle of a turn.
        println!("\n{}", xai::missing_subscription_notice());
    }
    Ok(())
}
