//! The device-code logins (GitHub Copilot, xAI Grok), as `/login` drives them.
//!
//! Split from `auth.rs` for size; both flows share the same shape -- request a
//! code, show it, poll -- and their engines live in `arterm_base::auth`.

use super::super::{App, DisplayMessage};
use super::auth::PendingLogin;
use super::helpers::copy_to_clipboard;
use crate::bus::{Bus, BusEvent, LoginCompleted};

impl App {
    pub(super) fn start_copilot_login(&mut self) {
        self.set_status_notice("Login: copilot device flow...");
        self.begin_pending_login(PendingLogin::Copilot);

        tokio::spawn(async move {
            let client = crate::provider::shared_http_client();

            let device_resp = match crate::auth::copilot::initiate_device_flow(&client).await {
                Ok(resp) => resp,
                Err(e) => {
                    Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                        provider: "copilot".to_string(),
                        success: false,
                        message: format!("Copilot device flow failed: {}", e),
                    }));
                    return;
                }
            };

            let user_code = device_resp.user_code.clone();
            let verification_uri = device_resp.verification_uri.clone();

            let clipboard_ok = copy_to_clipboard(&user_code);
            let clipboard_msg = if clipboard_ok {
                " (copied to clipboard - just paste it!)"
            } else {
                ""
            };

            Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                provider: "copilot_code".to_string(),
                success: true,
                message: {
                    let qr_section = crate::login_qr::markdown_section_for_tui(
                        &verification_uri,
                        "Scan this on another device to open the GitHub verification page:",
                    )
                    .map(|section| format!("\n\n{section}"))
                    .unwrap_or_default();
                    format!(
                        "GitHub Copilot Login\n\n\
                         Your code: {}{}\n\n\
                         Opening browser to {} ...\n\
                         Paste the code there and authorize.{}\n\n\
                         Waiting for authorization... (type /cancel to abort)",
                        user_code, clipboard_msg, verification_uri, qr_section
                    )
                },
            }));

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = Self::open_auth_browser(&verification_uri);

            let token = match crate::auth::copilot::poll_for_access_token(
                &client,
                &device_resp.device_code,
                device_resp.interval,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                        provider: "copilot".to_string(),
                        success: false,
                        message: format!("Copilot login failed: {}", e),
                    }));
                    return;
                }
            };

            let username = crate::auth::copilot::fetch_github_username(&client, &token)
                .await
                .unwrap_or_else(|_| "unknown".to_string());

            match crate::auth::copilot::save_github_token(&token, &username) {
                Ok(()) => {
                    Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                        provider: "copilot".to_string(),
                        success: true,
                        message: format!(
                            "Authenticated as {} via GitHub Copilot.\n\n\
                             Copilot models are now available in /model.",
                            username
                        ),
                    }));
                }
                Err(e) => {
                    Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                        provider: "copilot".to_string(),
                        success: false,
                        message: format!("Failed to save Copilot token: {}", e),
                    }));
                }
            }
        });

        self.push_display_message(DisplayMessage::system(
            "GitHub Copilot Login\n\n\
             Starting device flow... please wait. Type /cancel to abort."
                .to_string(),
        ));
    }

    /// The xAI device flow, streamed into the transcript.
    ///
    /// No browser is opened for the user: xAI's verification URL carries the
    /// code, and launching a browser mid-session steals focus from a terminal
    /// the user is reading. The URL and code are printed instead.
    pub(super) fn start_xai_subscription_login(&mut self) {
        self.set_status_notice("Login: xAI device flow...");
        self.begin_pending_login(PendingLogin::XaiSubscription);

        tokio::spawn(async move {
            let grant =
                match crate::auth::xai::request_device_code(crate::auth::xai::SURFACE_UI).await {
                    Ok(grant) => grant,
                    Err(e) => {
                        Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                            provider: "xai-oauth".to_string(),
                            success: false,
                            message: format!("xAI login could not start: {}", e),
                        }));
                        return;
                    }
                };

            let clipboard_note = if copy_to_clipboard(&grant.user_code) {
                " (copied to clipboard)"
            } else {
                ""
            };
            Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                provider: "xai_oauth_code".to_string(),
                success: true,
                message: format!(
                    "{}\n\nYour code: {}{}\n\nType /cancel to abort.",
                    crate::auth::xai::approval_instructions(&grant),
                    grant.user_code,
                    clipboard_note
                ),
            }));

            let tokens = match crate::auth::xai::poll_for_tokens(&grant).await {
                Ok(tokens) => tokens,
                Err(e) => {
                    Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                        provider: "xai-oauth".to_string(),
                        success: false,
                        message: format!("xAI login failed: {}", e),
                    }));
                    return;
                }
            };

            if let Err(e) = crate::auth::xai::save_tokens(&tokens) {
                Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                    provider: "xai-oauth".to_string(),
                    success: false,
                    message: format!("Failed to save the xAI login: {}", e),
                }));
                return;
            }

            // A login that worked against a plan that does not include API
            // access is reported here rather than as a 401 three prompts later.
            let message = if tokens.has_subscription_access() {
                "Signed in to xAI with your Grok subscription.".to_string()
            } else {
                crate::auth::xai::missing_subscription_notice().to_string()
            };
            Bus::global().publish(BusEvent::LoginCompleted(LoginCompleted {
                provider: "xai-oauth".to_string(),
                success: tokens.has_subscription_access(),
                message,
            }));
        });

        self.push_display_message(DisplayMessage::system(
            "xAI Login\n\nRequesting a device code from xAI... Type /cancel to abort.".to_string(),
        ));
    }
}
