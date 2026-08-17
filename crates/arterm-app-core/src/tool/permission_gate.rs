//! The granular permission gate: deny → ask → allow, most specific wins.
//!
//! Lives outside `tool::mod` because the reasoning is longer than the code and
//! `mod.rs` is already one of the repository's oversized files.
//!
//! `ask` blocks, for now. There is no interactive approval path in a live
//! session: `request_permission` exists but is ambient-only and answers through
//! a notification channel rather than the TUI. Before this, an `ask` rule fell
//! through and ran the command unchallenged -- measured, with a `deny` control:
//!
//! ```text
//! deny -> Tool call blocked by permission rules
//! ask  -> result_ok=true  command_actually_ran=true
//! ```
//!
//! The shipped config template offers `"ask Bash(npm publish)"` as an example,
//! so the person most likely to write an `ask` rule is the one who least wants
//! that call made for them. Failing closed keeps the promise the word makes;
//! when a session can actually ask, this becomes the prompt instead.

use crate::config::permission_rules::PermissionDecision;
use serde_json::Value;

/// What the gate decided about one tool call.
pub(super) enum GateOutcome {
    /// No rule matched, or the rule permits the call.
    Allow,
    /// Refuse. `reason` is the short form for the lifecycle log, `message` the
    /// sentence the model sees.
    Blocked {
        reason: &'static str,
        message: String,
    },
}

/// Evaluate the configured rules for one tool call.
pub(super) fn evaluate(resolved_name: &str, input: &Value) -> GateOutcome {
    let rules = &crate::config::config().permission_rules;
    if rules.is_empty() {
        return GateOutcome::Allow;
    }
    match rules.decide(resolved_name, input) {
        PermissionDecision::Deny => GateOutcome::Blocked {
            reason: "matched a deny permission rule",
            message: format!(
                "Tool call blocked by permission rules: {resolved_name} matched a deny rule"
            ),
        },
        PermissionDecision::Ask => GateOutcome::Blocked {
            reason: "matched an ask permission rule, and this session cannot ask",
            message: format!(
                "Tool call blocked by permission rules: {resolved_name} matched an `ask` rule, \
                 and interactive approval is not wired up yet, so the call is refused rather \
                 than run unasked. Change the rule to `allow` to permit it, or `deny` to make \
                 the refusal explicit."
            ),
        },
        PermissionDecision::Allow | PermissionDecision::Default => GateOutcome::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::super::permission_gate_tests::{bash_registry, ctx, with_config};

    /// An `ask` rule must not run the command. It used to: the decision was
    /// produced and then dropped, so `ask` behaved exactly like `allow` while
    /// reading like a gate. Measured before the fix -- the command executed,
    /// no prompt, no error -- with a `deny` control proving the harness saw
    /// the gate at all.
    #[tokio::test]
    async fn ask_rule_refuses_rather_than_running_unasked() {
        with_config("permission_rules = [\"ask Bash(touch *)\"]\n", async {
            let marker = std::env::temp_dir().join("arterm_ask_gate_probe");
            let _ = std::fs::remove_file(&marker);
            let registry = bash_registry();
            let err = registry
                .execute(
                    "bash",
                    serde_json::json!({"command": format!("touch {}", marker.display())}),
                    ctx("perm-ask-test"),
                )
                .await
                .expect_err("an ask rule must not let the call through");
            assert!(
                err.to_string().contains("ask"),
                "the refusal must say which rule refused: {err}"
            );
            assert!(
                !marker.exists(),
                "the command ran anyway: an ask rule is not a gate"
            );
            let _ = std::fs::remove_file(&marker);
        })
        .await;
    }
}
