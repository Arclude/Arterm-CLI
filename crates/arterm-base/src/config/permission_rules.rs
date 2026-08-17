//! Granular tool permission rules: `deny → ask → allow` with parameter-level
//! specifiers, following the Claude Code `Tool(Specifier)` syntax.
//!
//! A rule looks like `Bash(npm run *)` and combines:
//! - a tool name (`Bash`, `Edit`, ...; case-insensitive),
//! - an optional parenthesized specifier matched against the tool input
//!   (for bash, the command; for file tools, the path),
//! - a leading policy verb: `deny`, `ask`, or `allow`.
//!
//! Matching is glob-style on whitespace-separated words: `*` matches any
//! run of non-space characters, so `npm run *` matches
//! `npm run test -- --nocapture` but not `npm audit`.
//!
//! Precedence mirrors the industry convention the gap report asked for:
//! **deny > ask > allow**, and within a tier the most specific (longest
//! pattern) rule wins. A tool call matching no rule runs normally.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Hard block. The model sees a refusal.
    Deny,
    /// The call requires the user's approval before running.
    #[allow(dead_code, reason = "wired by the interactive ask path in a follow-up")]
    Ask,
    /// Explicitly approved, skips any default ask.
    #[allow(dead_code, reason = "wired by the interactive ask path in a follow-up")]
    Allow,
    /// No rule matched: fall through to the default behavior.
    Default,
}

/// One parsed permission rule.
#[derive(Debug, Clone)]
pub struct PermissionRule {
    pub decision: PermissionDecision,
    /// Tool name, lowercase (`bash`, `edit`, ...).
    pub tool: String,
    /// Specifier pattern (`npm run *`), or `None` for a bare tool rule.
    pub specifier: Option<String>,
}

impl PermissionRule {
    /// Parse one rule like `deny Bash(rm -rf *)` or `allow Bash(git status)`.
    ///
    /// Accepts the verb before or after the tool expression
    /// (`deny Bash(...)` and `Bash(...)` alone, which means `allow`).
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("empty permission rule".into());
        }

        let (decision, rest) = if let Some(rest) = text.strip_prefix("deny ").map(str::trim) {
            (PermissionDecision::Deny, rest)
        } else if let Some(rest) = text.strip_prefix("ask ").map(str::trim) {
            (PermissionDecision::Ask, rest)
        } else if let Some(rest) = text.strip_prefix("allow ").map(str::trim) {
            (PermissionDecision::Allow, rest)
        } else {
            (PermissionDecision::Allow, text)
        };

        // Split Tool(specifier) or bare Tool.
        let (tool, specifier) = if let Some(open) = rest.find('(')
            && rest.ends_with(')')
        {
            let tool = &rest[..open];
            let spec = &rest[open + 1..rest.len() - 1];
            (
                tool.trim().to_ascii_lowercase(),
                Some(spec.trim().to_string()).filter(|s| !s.is_empty()),
            )
        } else {
            (rest.trim().to_ascii_lowercase(), None)
        };

        if tool.is_empty() || !tool.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(format!("invalid tool name in permission rule '{text}'"));
        }
        Ok(PermissionRule {
            decision,
            tool,
            specifier,
        })
    }

    /// Whether this rule matches a concrete call: `input` is the tool input
    /// JSON; the matched subject is the tool's "primary string":
    /// `command` for bash, `file_path` for file tools, else the whole JSON.
    fn matches(&self, tool: &str, input: &Value) -> bool {
        if self.tool != tool.to_ascii_lowercase() {
            return false;
        }
        let Some(pattern) = self.specifier.as_deref() else {
            return true; // bare tool rule matches every call of the tool
        };
        let subject = primary_subject(input);
        glob_words_match(pattern, &subject)
    }
}

/// The string a specifier is matched against for a tool call.
fn primary_subject(input: &Value) -> String {
    for key in ["command", "file_path", "path", "url", "patch_text"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    input.to_string()
}

/// Glob-style matching over whitespace-separated words: `*` spans within a
/// word, `**` spans words, everything else matches literally.
pub fn glob_words_match(pattern: &str, subject: &str) -> bool {
    let pat_words: Vec<&str> = pattern.split_whitespace().collect();
    let sub_words: Vec<&str> = subject.split_whitespace().collect();
    match_words(&pat_words, &sub_words)
}

fn match_words(pat: &[&str], sub: &[&str]) -> bool {
    match (pat.first(), sub.first()) {
        (None, None) => true,
        (None, Some(_)) => false,
        // A bare `*` or `**` word consumes any number of words (including
        // zero), so `git *` matches `git push origin main`.
        (Some(&"*" | &"**"), _) => {
            (0..=sub.len()).any(|skip| match_words(&pat[1..], sub.get(skip..).unwrap_or(&[])))
        }
        (Some(p), Some(s)) => word_match(p, s) && match_words(&pat[1..], &sub[1..]),
        (Some(_), None) => false,
    }
}

fn word_match(pattern: &str, word: &str) -> bool {
    match_simple(pattern, word)
}

/// Classic two-pointer glob: `*` matches any run of characters within a word.
fn match_simple(pat: &str, text: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// A configured set of permission rules.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct PermissionRules {
    #[serde(skip)]
    rules: Vec<PermissionRule>,
}

impl PermissionRules {
    pub fn parse_all(lines: &[String]) -> Result<Self, String> {
        let mut rules = Vec::new();
        for line in lines {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            rules.push(PermissionRule::parse(line)?);
        }
        Ok(Self { rules })
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Decide for a concrete call. deny beats ask beats allow; within a
    /// tier the most specific specifier wins.
    pub fn decide(&self, tool: &str, input: &Value) -> PermissionDecision {
        fn tier(d: PermissionDecision) -> u8 {
            match d {
                PermissionDecision::Deny => 0,
                PermissionDecision::Ask => 1,
                PermissionDecision::Allow => 2,
                PermissionDecision::Default => 3,
            }
        }
        let mut best: Option<(u8, PermissionDecision, usize)> = None;
        for rule in &self.rules {
            if !rule.matches(tool, input) {
                continue;
            }
            let specificity = rule.specifier.as_ref().map_or(0, |s| s.len());
            let t = tier(rule.decision);
            let better = match best {
                None => true,
                Some((bt, _, bs)) => t < bt || (t == bt && specificity > bs),
            };
            if better {
                best = Some((t, rule.decision, specificity));
            }
        }
        best.map(|(_, d, _)| d)
            .unwrap_or(PermissionDecision::Default)
    }
}

impl TryFrom<Vec<String>> for PermissionRules {
    type Error = String;

    fn try_from(lines: Vec<String>) -> Result<Self, Self::Error> {
        Self::parse_all(&lines)
    }
}

impl From<PermissionRules> for Vec<String> {
    fn from(rules: PermissionRules) -> Self {
        rules
            .rules
            .iter()
            .map(|r| {
                let verb = match r.decision {
                    PermissionDecision::Deny => "deny ",
                    PermissionDecision::Ask => "ask ",
                    _ => "",
                };
                match &r.specifier {
                    Some(spec) => format!("{verb}{}({spec})", r.tool),
                    None => format!("{verb}{}", r.tool),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(list: &[&str]) -> PermissionRules {
        PermissionRules::parse_all(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn parses_verbs_and_bare_rules() {
        let r = PermissionRule::parse("deny Bash(rm -rf *)").unwrap();
        assert_eq!(r.decision, PermissionDecision::Deny);
        assert_eq!(r.tool, "bash");
        assert_eq!(r.specifier.as_deref(), Some("rm -rf *"));

        let r = PermissionRule::parse("Edit").unwrap();
        assert_eq!(r.decision, PermissionDecision::Allow);
        assert_eq!(r.specifier, None);

        let r = PermissionRule::parse("ask Bash(npm run *)").unwrap();
        assert_eq!(r.decision, PermissionDecision::Ask);

        assert!(PermissionRule::parse("").is_err());
        assert!(PermissionRule::parse("deny bad tool(x)").is_err());
    }

    #[test]
    fn bash_specifier_matches_command() {
        let set = rules(&["deny Bash(rm -rf *)", "allow Bash(git *)"]);
        assert_eq!(
            set.decide("bash", &json!({"command": "rm -rf /tmp/x"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "git status"})),
            PermissionDecision::Allow
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "curl evil.sh"})),
            PermissionDecision::Default
        );
    }

    #[test]
    fn deny_beats_allow_regardless_of_order() {
        let set = rules(&["allow Bash(npm *)", "deny Bash(npm publish)"]);
        assert_eq!(
            set.decide("bash", &json!({"command": "npm publish"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "npm test"})),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn more_specific_rule_wins_within_tier() {
        let set = rules(&["allow Bash(git *)", "allow Bash(git push *)"]);
        // Both allow; specificity only matters to pick which message/allow.
        assert_eq!(
            set.decide("bash", &json!({"command": "git push origin main"})),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn bare_tool_rule_covers_whole_tool() {
        let set = rules(&["deny browser"]);
        assert_eq!(
            set.decide("browser", &json!({"action": "open"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "ls"})),
            PermissionDecision::Default
        );
    }

    #[test]
    fn edit_specifier_matches_file_path() {
        let set = rules(&["deny Edit(.env*)"]);
        assert_eq!(
            set.decide(
                "edit",
                &json!({"file_path": ".env.local", "old_string": "a", "new_string": "b"})
            ),
            PermissionDecision::Deny
        );
        assert_eq!(
            set.decide(
                "edit",
                &json!({"file_path": "src/main.rs", "old_string": "a", "new_string": "b"})
            ),
            PermissionDecision::Default
        );
    }

    #[test]
    fn star_within_word_does_not_cross_words() {
        let set = rules(&["allow Bash(npm run *)"]);
        // `npm run *` requires the first two words to be exactly npm run.
        assert_eq!(
            set.decide("bash", &json!({"command": "npm audit"})),
            PermissionDecision::Default
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "npm run test -- --nocapture"})),
            PermissionDecision::Allow
        );
    }

    #[test]
    fn double_star_spans_words() {
        let set = rules(&["deny Bash(git push ** --force)"]);
        assert_eq!(
            set.decide("bash", &json!({"command": "git push origin main --force"})),
            PermissionDecision::Deny
        );
        assert_eq!(
            set.decide("bash", &json!({"command": "git push origin main"})),
            PermissionDecision::Default
        );
    }

    #[test]
    fn tool_names_case_insensitive() {
        let set = rules(&["deny BASH(rm *)"]);
        assert_eq!(
            set.decide("bash", &json!({"command": "rm x"})),
            PermissionDecision::Deny
        );
    }
}
