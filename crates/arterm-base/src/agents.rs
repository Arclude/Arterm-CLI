//! Custom agents: reusable subagent personas loaded from markdown files.
//!
//! An agent is a single markdown file with optional YAML frontmatter and a
//! prompt body, discovered from `./.arterm/agents/*.md` (project) and
//! `~/.arterm/agents/*.md` (global). Project files shadow global files with
//! the same name, mirroring the swarm-prompt precedence.
//!
//! Frontmatter fields (all optional, everything can also be inferred from a
//! plain file with no frontmatter):
//!
//! ```yaml
//! ---
//! name: api-reviewer          # defaults to the file stem
//! description: Reviews API changes for breaking edits  # shown in listings
//! model: fable-5              # route hint for the swarm spawn
//! effort: high                # reasoning effort hint
//! tools: [bash, read, agentgrep]  # tool allow-list hint
//! color: yellow               # UI accent hint
//! ---
//! You are a meticulous API reviewer...
//! ```
//!
//! The body becomes the agent's system prompt verbatim.

use std::path::{Path, PathBuf};

/// One parsed agent definition.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentDefinition {
    /// Unique slug used for invocation (file stem or frontmatter `name`).
    pub name: String,
    /// One-line description for listings and spawn help.
    pub description: String,
    /// Model routing hint passed through to the swarm spawn.
    pub model: Option<String>,
    /// Reasoning effort hint passed through to the swarm spawn.
    pub effort: Option<String>,
    /// Tool allow-list hint (empty = all tools).
    pub tools: Vec<String>,
    /// UI accent color hint.
    pub color: Option<String>,
    /// The prompt body (everything after the frontmatter), verbatim.
    pub prompt: String,
    /// Where this definition was loaded from.
    pub source: PathBuf,
}

impl AgentDefinition {
    /// Parse one agent markdown file.
    pub fn parse(path: &Path, content: &str) -> Result<Self, String> {
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("agent")
            .to_string();

        let (frontmatter, body) = split_frontmatter(content);
        let mut name = file_stem.clone();
        let mut description = String::new();
        let mut model = None;
        let mut effort = None;
        let mut tools = Vec::new();
        let mut color = None;

        if let Some(fm) = frontmatter {
            for line in fm.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let key = key.trim();
                let value = value.trim();
                match key {
                    "name" if !value.is_empty() => name = value.to_string(),
                    "description" => description = value.to_string(),
                    "model" if !value.is_empty() => model = Some(value.to_string()),
                    "effort" if !value.is_empty() => effort = Some(value.to_string()),
                    "tools" => {
                        tools = value
                            .trim_matches(|c| c == '[' || c == ']')
                            .split(',')
                            .map(str::trim)
                            .filter(|t| !t.is_empty())
                            .map(str::to_string)
                            .collect();
                    }
                    "color" if !value.is_empty() => color = Some(value.to_string()),
                    _ => {}
                }
            }
        }

        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!(
                "agent name '{name}' must be alphanumeric/-/_ (from {})",
                path.display()
            ));
        }

        let prompt = body.trim().to_string();
        if prompt.is_empty() {
            return Err(format!(
                "agent '{}' has an empty prompt body ({})",
                name,
                path.display()
            ));
        }

        Ok(AgentDefinition {
            name,
            description,
            model,
            effort,
            tools,
            color,
            prompt,
            source: path.to_path_buf(),
        })
    }
}

/// Split `---` frontmatter from the body. Returns `(None, whole)` when the
/// file has no frontmatter block.
fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    let trimmed = content.trim_start_matches('\u{feff}');
    let rest = match trimmed.strip_prefix("---") {
        Some(rest) if rest.starts_with('\n') || rest.starts_with("\r\n") => rest,
        _ => return (None, trimmed),
    };
    // Find the closing delimiter on its own line.
    for candidate in ["\n---", "\r\n---"] {
        if let Some(end) = rest.find(candidate) {
            let fm = &rest[..end];
            let after = &rest[end + candidate.len()..];
            // The closing --- must be alone on its line (end of line follows).
            if after.is_empty() || after.starts_with('\n') || after.starts_with('\r') {
                return (Some(fm.trim()), after.trim_start_matches(['\r', '\n']));
            }
        }
    }
    (None, trimmed)
}

/// A resolved set of agent definitions: project agents shadow global ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentRegistry {
    agents: Vec<AgentDefinition>,
}

impl AgentRegistry {
    /// Load agents for a working directory: `./.arterm/agents/*.md` layered
    /// over `~/.arterm/agents/*.md`. Invalid files are skipped (never fatal);
    /// the error is surfaced as the prefix in a listing when needed.
    pub fn load(working_dir: Option<&Path>) -> Self {
        let project_dir = working_dir.unwrap_or(Path::new("."));
        let mut agents: Vec<AgentDefinition> = Vec::new();

        let global_dir = crate::storage::arterm_dir()
            .ok()
            .map(|dir| dir.join("agents"));
        let project_agents = project_dir.join(".arterm").join("agents");

        // Global first, then project files shadow by name.
        for dir in [global_dir, Some(project_agents)].into_iter().flatten() {
            for agent in load_dir(&dir) {
                if let Some(existing) = agents.iter().position(|a| a.name == agent.name) {
                    agents[existing] = agent;
                } else {
                    agents.push(agent);
                }
            }
        }

        agents.sort_by(|a, b| a.name.cmp(&b.name));
        Self { agents }
    }

    pub fn is_empty(&self) -> bool {
        self.agents.is_empty()
    }

    pub fn len(&self) -> usize {
        self.agents.len()
    }

    pub fn get(&self, name: &str) -> Option<&AgentDefinition> {
        self.agents.iter().find(|a| a.name == name)
    }

    pub fn all(&self) -> &[AgentDefinition] {
        &self.agents
    }
}

fn load_dir(dir: &Path) -> Vec<AgentDefinition> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut agents = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        match AgentDefinition::parse(&path, &content) {
            Ok(agent) => agents.push(agent),
            Err(err) => {
                crate::logging::warn(&format!("skipping agent file: {err}"));
            }
        }
    }
    agents
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let path = Path::new("api-reviewer.md");
        let agent = AgentDefinition::parse(
            path,
            "---\nname: api-reviewer\ndescription: Reviews API diffs\nmodel: fable-5\neffort: high\ntools: [bash, read]\ncolor: yellow\n---\nYou review APIs.\n",
        )
        .unwrap();
        assert_eq!(agent.name, "api-reviewer");
        assert_eq!(agent.description, "Reviews API diffs");
        assert_eq!(agent.model.as_deref(), Some("fable-5"));
        assert_eq!(agent.effort.as_deref(), Some("high"));
        assert_eq!(agent.tools, vec!["bash", "read"]);
        assert_eq!(agent.color.as_deref(), Some("yellow"));
        assert_eq!(agent.prompt, "You review APIs.");
    }

    #[test]
    fn plain_file_defaults_to_file_stem() {
        let agent =
            AgentDefinition::parse(Path::new("refactorer.md"), "You refactor code.").unwrap();
        assert_eq!(agent.name, "refactorer");
        assert_eq!(agent.description, "");
        assert_eq!(agent.model, None);
        assert_eq!(agent.prompt, "You refactor code.");
    }

    #[test]
    fn rejects_empty_body_and_bad_names() {
        assert!(AgentDefinition::parse(Path::new("x.md"), "---\nname: x\n---\n").is_err());
        assert!(
            AgentDefinition::parse(Path::new("x.md"), "---\nname: bad name!\n---\nbody").is_err()
        );
    }

    #[test]
    fn unmatched_frontmatter_is_treated_as_body() {
        // No closing ---: the whole thing is the prompt, no fields parsed.
        let agent =
            AgentDefinition::parse(Path::new("a.md"), "---\nname: nope\nbody text").unwrap();
        assert_eq!(agent.name, "a");
        assert!(agent.prompt.starts_with("---"));
    }

    #[test]
    fn project_shadows_global() {
        let tmp = tempfile::tempdir().unwrap();
        let global_dir = tmp.path().join("global-agents");
        let project_dir = tmp.path().join("project");
        std::fs::create_dir_all(global_dir.join("agents")).unwrap();
        std::fs::create_dir_all(project_dir.join(".arterm").join("agents")).unwrap();
        std::fs::write(
            global_dir.join("agents").join("reviewer.md"),
            "global reviewer",
        )
        .unwrap();
        std::fs::write(
            global_dir.join("agents").join("only-global.md"),
            "only in global",
        )
        .unwrap();
        std::fs::write(
            project_dir
                .join(".arterm")
                .join("agents")
                .join("reviewer.md"),
            "project reviewer",
        )
        .unwrap();

        let prev = std::env::var_os("ARTERM_HOME");
        unsafe { std::env::set_var("ARTERM_HOME", &global_dir) };
        let registry = AgentRegistry::load(Some(&project_dir));
        match prev {
            Some(v) => unsafe { std::env::set_var("ARTERM_HOME", v) },
            None => unsafe { std::env::remove_var("ARTERM_HOME") },
        }

        assert_eq!(registry.len(), 2);
        assert_eq!(registry.get("reviewer").unwrap().prompt, "project reviewer");
        assert_eq!(
            registry.get("only-global").unwrap().prompt,
            "only in global"
        );
    }
}
