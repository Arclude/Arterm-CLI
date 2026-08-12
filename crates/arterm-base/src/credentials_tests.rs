use super::*;

fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

fn names(scrubbed: &ScrubbedEnv) -> Vec<&str> {
    scrubbed.env.keys().map(String::as_str).collect()
}

#[test]
fn unwired_callers_still_scrub() {
    // The property the whole file rests on: `None` settings is not "no policy",
    // it is the default policy. A hook or a test that never read the config
    // must not be the one path that still hands the keys over.
    let scrubbed = scrub_env(
        env(&[("ANTHROPIC_API_KEY", "sk-secret"), ("PATH", "/usr/bin")]),
        None,
    );
    assert_eq!(names(&scrubbed), vec!["PATH"]);
    assert_eq!(scrubbed.withheld, vec!["ANTHROPIC_API_KEY"]);
}

#[test]
fn the_three_keys_this_was_written_for_are_withheld() {
    let scrubbed = scrub_env(
        env(&[
            ("ANTHROPIC_API_KEY", "sk-ant"),
            ("OPENAI_API_KEY", "sk-oai"),
            ("ARTERM_SECRET", "unlocks-the-keystore"),
        ]),
        None,
    );
    assert!(scrubbed.env.is_empty(), "left behind: {:?}", scrubbed.env);
    assert_eq!(
        scrubbed.withheld,
        vec!["ANTHROPIC_API_KEY", "ARTERM_SECRET", "OPENAI_API_KEY"],
        "and sorted, because a name is the actionable half"
    );
}

#[test]
fn the_toolchain_survives() {
    // These are the false positives that would have sunk the feature. Each one
    // starts with a word from the pattern and runs on into another, which is
    // exactly what the `_`-boundary anchoring exists to allow.
    //
    // SSH_AUTH_SOCK is a socket path, not a secret: withholding it breaks
    // `git push` over SSH. XDG_SESSION_* is desktop plumbing a stray SESSION
    // alternative would have swept up.
    let passthrough = [
        "PATH",
        "HOME",
        "LANG",
        "TERM",
        "TOKENIZERS_PARALLELISM",
        "KEYBOARD_LAYOUT",
        "SSH_ASKPASS",
        "SSH_AUTH_SOCK",
        "XDG_SESSION_TYPE",
        "XDG_SESSION_ID",
        "PASSENGER_ROOT",
        "KEYCLOAK_URL",
        "MONKEYS",
    ];
    for name in passthrough {
        let scrubbed = scrub_env(env(&[(name, "value")]), None);
        assert!(
            scrubbed.withheld.is_empty(),
            "{name} must pass through untouched; a control that breaks the \
             toolchain is one people switch off"
        );
    }
}

#[test]
fn credential_shapes_are_caught_wherever_the_word_sits() {
    let withheld = [
        "API_KEY",
        "GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_ACCESS_KEY_ID",
        "DB_PASSWORD",
        "MY_PASSPHRASE",
        "GOOGLE_CREDENTIALS",
        "SSH_PRIVATE_KEY",
        "OAUTH_CLIENT_SECRET",
        "SLACK_AUTH_TOKEN",
        "SESSION_TOKEN",
        "BEARER",
        "COOKIE",
        "JWT_SIGNING_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "SECRETS",
        "KEYS",
    ];
    for name in withheld {
        let scrubbed = scrub_env(env(&[(name, "value")]), None);
        assert_eq!(scrubbed.withheld, vec![name.to_string()], "missed {name}");
    }
}

#[test]
fn names_are_judged_never_values() {
    // A value that screams "secret" under a name that does not is handed over,
    // deliberately. Value-sniffing eventually eats a PATH entry, and this is
    // the test that pins the choice rather than leaving it to a comment.
    let scrubbed = scrub_env(
        env(&[("EDITOR", "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa")]),
        None,
    );
    assert!(scrubbed.withheld.is_empty());
    assert_eq!(names(&scrubbed), vec!["EDITOR"]);
}

#[test]
fn allow_hands_one_back_and_deny_outranks_it() {
    let settings = CredentialsConfig {
        scrub: true,
        allow: vec!["GITHUB_TOKEN".to_string(), "SHARED".to_string()],
        deny: vec!["DATABASE_URL".to_string(), "SHARED".to_string()],
    };
    let scrubbed = scrub_env(
        env(&[
            ("GITHUB_TOKEN", "gh"),
            ("DATABASE_URL", "postgres://u:p@h/db"),
            ("SHARED", "in both lists"),
            ("ANTHROPIC_API_KEY", "sk"),
        ]),
        Some(&settings),
    );
    assert_eq!(names(&scrubbed), vec!["GITHUB_TOKEN"]);
    assert_eq!(
        scrubbed.withheld,
        vec!["ANTHROPIC_API_KEY", "DATABASE_URL", "SHARED"],
        "an overlap is a config mistake, and the safe reading of one is closed"
    );
}

#[test]
fn allow_and_deny_match_case_insensitively() {
    // Correct on Windows, merely generous on POSIX. The reverse would silently
    // fail to withhold `Api_Key` on the platform where that IS the same
    // variable.
    let settings = CredentialsConfig {
        scrub: true,
        allow: vec!["github_token".to_string()],
        ..Default::default()
    };
    let scrubbed = scrub_env(env(&[("GITHUB_TOKEN", "gh")]), Some(&settings));
    assert_eq!(names(&scrubbed), vec!["GITHUB_TOKEN"]);

    let scrubbed = scrub_env(env(&[("Api_Key", "x")]), None);
    assert_eq!(scrubbed.withheld, vec!["Api_Key"]);
}

#[test]
fn scrub_false_is_a_decision_and_is_honored() {
    let settings = CredentialsConfig {
        scrub: false,
        ..Default::default()
    };
    let scrubbed = scrub_env(
        env(&[("ANTHROPIC_API_KEY", "sk"), ("PATH", "/usr/bin")]),
        Some(&settings),
    );
    assert_eq!(names(&scrubbed), vec!["ANTHROPIC_API_KEY", "PATH"]);
    assert!(scrubbed.withheld.is_empty());
}

#[test]
fn the_note_reports_only_names_the_evidence_mentions() {
    let withheld = vec!["GITHUB_TOKEN".to_string(), "ANTHROPIC_API_KEY".to_string()];

    // The case it was written for: the failing tool says which variable it
    // wanted.
    let note = withheld_note(
        &withheld,
        "gh: To use GitHub CLI, set GITHUB_TOKEN",
        WITHHELD_NOTE_LIMIT,
    )
    .expect("a named variable is worth reporting");
    assert!(note.contains("GITHUB_TOKEN"), "{note}");
    assert!(
        !note.contains("ANTHROPIC_API_KEY"),
        "an unrelated key must not be named: {note}"
    );

    // And the case that would have made it noise: almost every session has a
    // key in its environment, so an unconditional note would append itself to
    // every failing command in the repo.
    assert!(
        withheld_note(&withheld, "2 tests failed", WITHHELD_NOTE_LIMIT).is_none(),
        "a failure that names nothing has nothing to learn from this"
    );
}

#[test]
fn the_note_caps_what_it_spells_out() {
    let withheld: Vec<String> = (0..9).map(|i| format!("A{i}_TOKEN")).collect();
    let evidence = withheld.join(" ");
    let note = withheld_note(&withheld, &evidence, 6).expect("all nine are named");
    assert!(note.contains("+3 more"), "{note}");
}

#[test]
fn redaction_covers_the_ways_a_secret_reaches_a_command_line() {
    let argv: Vec<String> = [
        "curl",
        "-H",
        "Authorization: Bearer sk-secret",
        "-H",
        "Accept: application/json",
        "--token",
        "sk-flag-value",
        "--api-key=sk-assigned",
        "API_KEY=sk-env-style",
        "https://api.example.com/v1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let redacted = redact_command(&argv).join(" ");

    for secret in ["sk-secret", "sk-flag-value", "sk-assigned", "sk-env-style"] {
        assert!(!redacted.contains(secret), "{secret} survived: {redacted}");
    }
    // Readable is the point: a redactor that eats the ordinary arguments makes
    // the process list useless, which is how a control stops being used.
    assert!(redacted.contains("Accept: application/json"), "{redacted}");
    assert!(
        redacted.contains("https://api.example.com/v1"),
        "{redacted}"
    );
    assert!(redacted.contains("--token"), "{redacted}");
}

#[test]
fn redaction_leaves_things_that_merely_contain_a_colon_alone() {
    let argv: Vec<String> = ["git", "clone", "https://github.com/a/b.git", "C:\\src"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(redact_command(&argv), argv);
}
