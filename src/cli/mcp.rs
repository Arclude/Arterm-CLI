//! `arterm mcp` — manage MCP server config from the command line.
//!
//! Only the two files arterm owns are edited here: `~/.arterm/mcp.json`
//! (user scope) and `.arterm/mcp.json` (project scope). Servers imported
//! from Claude Code / Codex configs show up in `list` as read-only sources;
//! removing those means editing the original file, and `remove` says so
//! instead of silently doing nothing.

use super::args::{McpCommand, McpScopeArg};
use crate::mcp::{McpConfig, McpServerConfig};
use anyhow::{Context, Result, bail};
use std::collections::HashMap;
use std::path::PathBuf;

pub(crate) fn run_mcp_command(action: McpCommand) -> Result<()> {
    match action {
        McpCommand::List { json } => run_list(json),
        McpCommand::Add {
            name,
            env,
            scope,
            no_share,
            command,
        } => run_add(name, env, scope, no_share, command),
        McpCommand::Remove { name, scope } => run_remove(name, scope),
    }
}

fn user_config_path() -> Result<PathBuf> {
    Ok(crate::storage::arterm_dir()?.join("mcp.json"))
}

fn project_config_path() -> PathBuf {
    PathBuf::from(".arterm/mcp.json")
}

fn scope_path(scope: McpScopeArg) -> Result<PathBuf> {
    match scope {
        McpScopeArg::User => user_config_path(),
        McpScopeArg::Project => Ok(project_config_path()),
    }
}

fn scope_label(scope: McpScopeArg) -> &'static str {
    match scope {
        McpScopeArg::User => "user (~/.arterm/mcp.json)",
        McpScopeArg::Project => "project (.arterm/mcp.json)",
    }
}

fn load_file_or_empty(path: &std::path::Path) -> Result<McpConfig> {
    if !path.exists() {
        return Ok(McpConfig::default());
    }
    McpConfig::load_from_file(path).with_context(|| format!("failed to parse {}", path.display()))
}

/// The editable sources, lowest precedence first (matching
/// `McpConfig::load_for_dir`: project files override user files).
fn editable_sources() -> Vec<(McpScopeArg, PathBuf)> {
    let mut sources = Vec::new();
    if let Ok(path) = user_config_path() {
        sources.push((McpScopeArg::User, path));
    }
    sources.push((McpScopeArg::Project, project_config_path()));
    sources
}

const IMPORTED_SOURCE: &str = "imported (Claude Code/Codex config)";

/// One effective server as `list` reports it. Env keys only: values may hold
/// secrets and must never reach stdout.
#[derive(serde::Serialize)]
struct ListRow {
    name: String,
    command: String,
    args: Vec<String>,
    env_keys: Vec<String>,
    enabled: bool,
    shared: bool,
    source: String,
}

/// One row per effective server (merged view, sorted by name), each attributed
/// to the highest-precedence editable file defining it; anything else came
/// from an imported source (~/.claude.json, ~/.claude/mcp.json, .mcp.json,
/// .claude/mcp.json).
fn list_rows() -> Vec<ListRow> {
    // The effective view a session will get for this directory (merged,
    // env-expanded, non-stdio entries dropped).
    let effective = McpConfig::load();

    let mut source_by_name: HashMap<String, String> = HashMap::new();
    for (scope, path) in editable_sources() {
        if let Ok(config) = load_file_or_empty(&path) {
            for name in config.servers.keys() {
                source_by_name.insert(name.clone(), scope_label(scope).to_string());
            }
        }
    }

    let mut names: Vec<&String> = effective.servers.keys().collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let cfg = &effective.servers[name];
            let mut env_keys: Vec<String> = cfg.env.keys().cloned().collect();
            env_keys.sort();
            ListRow {
                name: name.clone(),
                command: cfg.command.clone(),
                args: cfg.args.clone(),
                env_keys,
                enabled: cfg.is_enabled(),
                shared: cfg.shared,
                source: source_by_name
                    .get(name.as_str())
                    .cloned()
                    .unwrap_or_else(|| IMPORTED_SOURCE.to_string()),
            }
        })
        .collect()
}

fn run_list(json: bool) -> Result<()> {
    let rows = list_rows();

    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }

    if rows.is_empty() {
        println!("No MCP servers configured.");
        println!();
        println!("Add one with:");
        println!("  arterm mcp add <name> <command> [args...]");
        println!("  arterm mcp add --scope project <name> <command> [args...]");
        return Ok(());
    }

    println!("MCP servers ({}):", rows.len());
    println!();
    for row in &rows {
        let state = if row.enabled { "" } else { "  [disabled]" };
        println!("  {}{}", row.name, state);
        println!("    command: {} {}", row.command, row.args.join(" "));
        if !row.env_keys.is_empty() {
            println!("    env: {}", row.env_keys.join(", "));
        }
        if !row.shared {
            println!("    shared: no (one process per session)");
        }
        println!("    source: {}", row.source);
        println!();
    }
    println!("Tools appear to the model as mcp__<server>__<tool>.");
    Ok(())
}

fn parse_env_pairs(pairs: &[String]) -> Result<HashMap<String, String>> {
    let mut env = HashMap::new();
    for pair in pairs {
        let Some((key, value)) = pair.split_once('=') else {
            bail!("--env expects KEY=VALUE, got '{}'", pair);
        };
        if key.is_empty() {
            bail!("--env expects a non-empty key in '{}'", pair);
        }
        env.insert(key.to_string(), value.to_string());
    }
    Ok(env)
}

fn run_add(
    name: String,
    env: Vec<String>,
    scope: McpScopeArg,
    no_share: bool,
    command: Vec<String>,
) -> Result<()> {
    let env = parse_env_pairs(&env)?;
    let mut parts = command.into_iter();
    let program = parts.next().context("a server command is required")?;
    let args: Vec<String> = parts.collect();
    let misplaced_own_flag = ["--env", "--scope", "--no-share"]
        .into_iter()
        .find(|flag| args.iter().any(|arg| arg == flag));

    let path = scope_path(scope)?;
    let mut config = load_file_or_empty(&path)?;
    let replaced = config
        .servers
        .insert(
            name.clone(),
            McpServerConfig {
                command: program,
                args,
                env,
                shared: !no_share,
                transport: None,
                url: None,
                headers: HashMap::new(),
                enabled: None,
                disabled: None,
            },
        )
        .is_some();
    config
        .save_to_file(&path)
        .with_context(|| format!("failed to write {}", path.display()))?;

    if replaced {
        println!("Replaced MCP server '{}' in {}", name, scope_label(scope));
    } else {
        println!("Added MCP server '{}' to {}", name, scope_label(scope));
    }
    println!(
        "Its tools will appear as mcp__{}__<tool> in new sessions.",
        name
    );

    // Everything after the server command is passed to the server verbatim,
    // including tokens that look like this command's own flags. That is what
    // lets servers take flags of their own, but when one of OUR flags shows up
    // there it is almost always a misplaced arterm flag — say so instead of
    // storing it silently.
    if let Some(misplaced) = misplaced_own_flag {
        println!(
            "note: '{}' came after the server command, so it is passed to the \
             server itself. If you meant it for arterm, put it before the \
             command: arterm mcp add {} ... {} <command> ...",
            misplaced, misplaced, name
        );
    }
    Ok(())
}

fn run_remove(name: String, scope: Option<McpScopeArg>) -> Result<()> {
    let scopes = match scope {
        Some(scope) => vec![scope],
        None => vec![McpScopeArg::User, McpScopeArg::Project],
    };

    let mut removed_from: Vec<&'static str> = Vec::new();
    for scope in scopes {
        let path = scope_path(scope)?;
        let mut config = load_file_or_empty(&path)?;
        if config.servers.remove(&name).is_some() {
            config
                .save_to_file(&path)
                .with_context(|| format!("failed to write {}", path.display()))?;
            removed_from.push(scope_label(scope));
        }
    }

    if !removed_from.is_empty() {
        println!(
            "Removed MCP server '{}' from {}",
            name,
            removed_from.join(" and ")
        );
        return Ok(());
    }

    // Not in either editable file. If it still shows up in the merged view it
    // comes from an imported source; say where to edit instead of failing dumb.
    let effective = McpConfig::load();
    if effective.servers.contains_key(&name) {
        bail!(
            "'{}' comes from an imported config (~/.claude.json, ~/.claude/mcp.json, \
             .mcp.json, or .claude/mcp.json); edit that file to remove it",
            name
        );
    }
    bail!("no MCP server named '{}' in user or project config", name);
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod mcp_tests;
