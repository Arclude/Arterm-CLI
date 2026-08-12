//! What a model-authored command inherits from the session's environment.
//!
//! `arterm-command-risk` answers whether a command may run at all. This file
//! answers the question standing next to it: what the command is HANDED before
//! it runs. `bash` spawns with the agent process's own environment, and that
//! environment is where the user put the credentials they gave to Arterm —
//! `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `ARTERM_SECRET`, which unlocks
//! the keystore holding every other one.
//!
//! The leak is one command long. `env` prints them, and the moment it does they
//! are in the transcript: sent to the provider on the next turn, written to the
//! session file on disk, quoted into swarm members' prompts, and folded into
//! whatever a compaction summarizes. It is also not something the model has to
//! intend — `npm install` runs package scripts with the same inherited
//! environment, so a dependency can read them without the model ever asking.
//!
//! The rule is about NAMES, never values. A variable whose name says it holds a
//! credential is withheld; everything else passes through untouched. Guessing
//! from values ("this looks like a token") would eventually eat a `PATH` entry,
//! and a control that breaks the toolchain gets switched off.
//!
//! Scrubbing is the DEFAULT, including for a caller that passes no settings at
//! all: a spawn assembled without this wiring (a hook, a test, a standalone
//! call) must not be the one path that still hands the keys over. Turning it
//! off is `credentials.scrub = false`, said deliberately.
//!
//! Ported from the TypeScript CLI's `core/src/credentials.ts`, which carries
//! the longer argument for each of these choices.

use arterm_config_types::CredentialsConfig;
use regex::Regex;
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

/// Names that say "I hold a credential".
///
/// Every alternative is anchored on a `_` boundary or the whole name, which is
/// what keeps the list from eating its neighbours: `TOKENIZERS_PARALLELISM`,
/// `KEYBOARD_LAYOUT` and `SSH_ASKPASS` all survive because the word they start
/// with runs on into another one.
///
/// Two credential-adjacent names are deliberately absent. `SSH_AUTH_SOCK` is a
/// socket path, not a secret, and withholding it breaks `git push` over SSH in
/// the attended sessions that still do that by hand. `XDG_SESSION_*` are
/// desktop plumbing that a stray `SESSION` alternative would have swept up.
/// Both are the false positives that would have made this feature something
/// people disable.
static CREDENTIAL_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|_)(?:API_?KEYS?|KEYS?|ACCESS_?KEY(?:_?ID)?|SECRETS?|TOKENS?|PASS(?:WORD|WD|PHRASE)?|CREDENTIALS?|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?TOKEN|SESSION_?TOKEN|BEARER|COOKIE|SIGNING_?KEY|WEBHOOK_?SECRET)(?:_|$)",
    )
    .expect("credential name pattern is a compile-time constant")
});

/// Header names that carry a credential but do not look like one by the rule
/// above. `Authorization` is the whole reason: `curl -H "Authorization: Bearer …"`
/// is the ordinary way a secret reaches a command line, and no `_`-delimited
/// alternative catches the word on its own.
static CREDENTIAL_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:authorization|proxy-authorization|x-api-key|cookie)$")
        .expect("credential header pattern is a compile-time constant")
});

/// The placeholder a redacted value becomes. Distinct enough to be searchable.
const REDACTED: &str = "«redacted»";

/// A child environment plus the names that did not make it into one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScrubbedEnv {
    /// The environment to hand the child, as an EXHAUSTIVE map. Callers must
    /// clear the inherited environment before applying it — see [`scrub_env`].
    pub env: BTreeMap<String, String>,
    /// Names withheld, sorted — names are not secret, and knowing one is the fix.
    pub withheld: Vec<String>,
}

/// Build the environment a spawned command actually gets.
///
/// Pure and total: it never reads the process environment itself, so a test can
/// state the whole input, and the caller decides what "the base environment"
/// means.
///
/// **The result is the WHOLE environment, not an overlay.** A caller that
/// applies it with `Command::envs` alone changes nothing, because a child
/// inherits the parent's environment and `envs` only adds to it — the withheld
/// names would still be there, inherited. `env_clear()` first is what makes
/// this a scrub rather than a decoration. That is the same trap the TS side
/// documents as `extendEnv: false`: there, execa merged into `process.env` by
/// default and passing a scrubbed map alone handed the originals through
/// anyway.
pub fn scrub_env<I, K, V>(base: I, settings: Option<&CredentialsConfig>) -> ScrubbedEnv
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<String>,
    V: Into<String>,
{
    let base = base.into_iter().map(|(k, v)| (k.into(), v.into()));

    if settings.is_some_and(|s| !s.scrub) {
        return ScrubbedEnv {
            env: base.collect(),
            withheld: Vec::new(),
        };
    }

    // Env var names are case-sensitive on POSIX and case-insensitive on
    // Windows. Matching the lists case-insensitively is the behaviour that is
    // correct on one platform and merely generous on the other; the reverse
    // would silently fail to withhold `Api_Key` on the platform where that is
    // the same variable.
    let allow: HashSet<String> = settings
        .map(|s| s.allow.iter().map(|n| n.to_uppercase()).collect())
        .unwrap_or_default();
    let deny: HashSet<String> = settings
        .map(|s| s.deny.iter().map(|n| n.to_uppercase()).collect())
        .unwrap_or_default();

    let mut env = BTreeMap::new();
    let mut withheld = Vec::new();
    for (name, value) in base {
        if withholds(&name, &allow, &deny) {
            withheld.push(name);
        } else {
            env.insert(name, value);
        }
    }
    withheld.sort();
    ScrubbedEnv { env, withheld }
}

/// Convenience over [`scrub_env`] for the ordinary caller: the current process
/// environment, scrubbed.
pub fn scrub_current_env(settings: Option<&CredentialsConfig>) -> ScrubbedEnv {
    scrub_env(std::env::vars(), settings)
}

fn withholds(name: &str, allow: &HashSet<String>, deny: &HashSet<String>) -> bool {
    let key = name.to_uppercase();
    // An explicit `deny` outranks an explicit `allow`: the two lists
    // overlapping is a config mistake, and the safe reading of a mistake is
    // the closed one.
    if deny.contains(&key) {
        return true;
    }
    if allow.contains(&key) {
        return false;
    }
    CREDENTIAL_NAME.is_match(name)
}

/// The line a failed command gets told about what it did not receive.
///
/// Without it a missing `GITHUB_TOKEN` reads as an unexplained `gh` failure,
/// and an agent that cannot see why a command failed runs it again — three
/// iterations spent discovering what one sentence could have said.
///
/// `evidence` is what keeps that from becoming noise, and it is the reason this
/// takes an argument at all. Almost every session has an API key in its
/// environment, so an unconditional note would append itself to EVERY failing
/// command — a line about credentials under each failing test run, pointing the
/// model at the wrong cause of a failure that had nothing to do with them. So a
/// name is reported only when the command text or its output actually names it,
/// which is the case the note was written for: tools that need a variable say
/// which one ("set GITHUB_TOKEN"), and a command that reads one spells it out.
///
/// Names only, capped. A name is the actionable half and is not itself a
/// secret; the value is the thing that must never be echoed back into the
/// transcript.
pub fn withheld_note(withheld: &[String], evidence: &str, limit: usize) -> Option<String> {
    let relevant: Vec<&String> = withheld
        .iter()
        .filter(|name| evidence.contains(name.as_str()))
        .collect();
    if relevant.is_empty() {
        return None;
    }
    let shown = relevant
        .iter()
        .take(limit)
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let rest = if relevant.len() > limit {
        format!(", +{} more", relevant.len() - limit)
    } else {
        String::new()
    };
    Some(format!(
        "[Withheld from this command's environment: {shown}{rest}. Arterm holds back \
         credential-named variables so they cannot reach the transcript; list the ones this \
         command needs under `credentials.allow` in config.toml, or pass the value inline.]"
    ))
}

/// The default number of withheld names a note will spell out.
pub const WITHHELD_NOTE_LIMIT: usize = 6;

/// True when a flag or variable NAME says the thing beside it is a credential.
fn credential_name(name: &str) -> bool {
    let normalized = name.trim_start_matches('-').replace('-', "_");
    CREDENTIAL_NAME.is_match(&normalized)
}

/// A command line safe to show and to store.
///
/// The environment scrub keeps credentials out of what a command INHERITS; this
/// keeps them out of what a command is RECORDED as. A background process's argv
/// is written to the registry, printed by the process list, and read back by
/// the model — so `curl -H "Authorization: Bearer …"` would put the secret in
/// exactly the places [`scrub_env`] exists to keep it out of.
///
/// Same rule and same reason: judged by NAME, never by value. A blob that
/// "looks like a token" is as likely to be a commit hash or a base64 fixture,
/// and a redactor that eats those makes the process list unreadable — which is
/// how a control stops being used.
pub fn redact_command(argv: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(argv.len());
    let mut redact_next = false;
    for arg in argv {
        if redact_next {
            out.push(REDACTED.to_string());
            redact_next = false;
            continue;
        }
        // `--token=value` and `API_KEY=value`.
        if let Some((name, _)) = arg.split_once('=')
            && !name.is_empty()
            && !name.contains(char::is_whitespace)
            && credential_name(name)
        {
            out.push(format!("{name}={REDACTED}"));
            continue;
        }
        // `Authorization: Bearer …`, usually inside a `-H` argument.
        if let Some((name, value)) = arg.split_once(':')
            && !value.trim().is_empty()
            && is_header_name(name)
            && (CREDENTIAL_HEADER.is_match(name) || credential_name(name))
        {
            out.push(format!("{name}: {REDACTED}"));
            continue;
        }
        // `--token value`: the flag names it, so the NEXT argument is the secret.
        if arg.starts_with('-') && credential_name(arg) {
            out.push(arg.clone());
            redact_next = true;
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// Whether the text before a `:` is shaped like an HTTP header name, so that
/// `https://example.com/x` and `C:\path` are not read as headers.
fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
