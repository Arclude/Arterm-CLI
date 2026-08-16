//! `arterm memory clean` — delete stored project memory.
//!
//! Project scope only: global memory is never touched here. The default is this
//! project's memory (the same file `arterm memory list`/`stats` read);
//! `--all-projects` clears every project on the machine. Both prompt before an
//! irreversible delete unless `--yes`.
//!
//! Kept out of `commands.rs` and `dispatch.rs` because both are over the
//! oversized-file ratchet's threshold. `map_memory_subcommand` moves here too,
//! which leaves `dispatch.rs` smaller than a Clean arm alone would have left it.

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

use crate::cli::args::MemoryCommand;
use crate::cli::commands::{self, MemorySubcommand};
use crate::memory::MemoryManager;
use crate::storage;

/// Run `arterm memory clean`.
pub(crate) fn run(all_projects: bool, yes: bool) -> Result<()> {
    if all_projects {
        if !yes && !confirm("every project's memory on this machine")? {
            println!("Nothing was cleaned.");
            return Ok(());
        }
        let dir = storage::arterm_dir()?.join("memory").join("projects");
        match clear_projects_dir(&dir)? {
            0 => println!("No project memory to clean."),
            1 => println!("Cleaned 1 project's memory. Global memory is untouched."),
            n => println!("Cleaned {n} projects' memory. Global memory is untouched."),
        }
        return Ok(());
    }

    if !yes && !confirm("this project's memory")? {
        println!("Nothing was cleaned.");
        return Ok(());
    }
    let cleaned = match MemoryManager::new().project_memory_path()? {
        Some(path) => remove_store_at(&path)?,
        None => false,
    };
    if cleaned {
        println!("Cleaned this project's memory. Global memory is untouched.");
        println!("Run `arterm memory clean --all-projects` to clear every project.");
    } else {
        println!("This project has no stored memory to clean.");
    }
    Ok(())
}

/// Ask before an irreversible delete. Returns true only on an explicit yes.
///
/// A no, an empty line, or EOF (piped with no `--yes`) all count as "do not
/// delete" — the safe default for something that cannot be undone.
fn confirm(target: &str) -> Result<bool> {
    let mut stdout = std::io::stdout();
    write!(
        stdout,
        "This permanently deletes {target}. Continue? [y/N] "
    )
    .and_then(|()| stdout.flush())
    .context("writing the confirmation prompt")?;
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer)? == 0 {
        return Ok(false); // EOF: no one is there to confirm.
    }
    let answer = answer.trim().to_ascii_lowercase();
    Ok(answer == "y" || answer == "yes")
}

/// Remove one store file and its `.json.bak` sibling. Returns whether the store
/// existed. Path-based so it can be tested without moving `ARTERM_HOME`.
fn remove_store_at(path: &Path) -> Result<bool> {
    let existed = path.exists();
    if existed {
        std::fs::remove_file(path)
            .with_context(|| format!("removing project memory at {}", path.display()))?;
    }
    // The migration backup is a copy of what was just deleted; leaving it means
    // the memory was not really cleared, so its removal is part of the job.
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        std::fs::remove_file(&backup)
            .with_context(|| format!("removing the backup at {}", backup.display()))?;
    }
    Ok(existed)
}

/// Remove every `<hash>.json` (and its `.json.bak`) under `dir`, returning how
/// many stores were removed.
fn clear_projects_dir(dir: &Path) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in std::fs::read_dir(dir)
        .with_context(|| format!("reading project memory directory {}", dir.display()))?
    {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Both the store (`<hash>.json`) and its backup (`<hash>.json.bak`).
        if name.ends_with(".json") || name.ends_with(".json.bak") {
            std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
            if name.ends_with(".json") {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Map the parsed `memory` subcommand onto the handler enum. Moved here from
/// `dispatch.rs` (over the oversized-file ratchet) so the Clean arm nets that
/// file smaller, not larger.
pub(crate) fn map_memory_subcommand(subcmd: MemoryCommand) -> MemorySubcommand {
    match subcmd {
        MemoryCommand::List { scope, tag } => MemorySubcommand::List { scope, tag },
        MemoryCommand::Search { query, semantic } => MemorySubcommand::Search { query, semantic },
        MemoryCommand::Export { output, scope } => MemorySubcommand::Export { output, scope },
        MemoryCommand::Import {
            input,
            scope,
            overwrite,
        } => MemorySubcommand::Import {
            input,
            scope,
            overwrite,
        },
        MemoryCommand::Stats => MemorySubcommand::Stats,
        MemoryCommand::ClearTest => MemorySubcommand::ClearTest,
        // Clean is handled before this mapping (see dispatch), so it never
        // reaches the shared `run_memory_command`.
        MemoryCommand::Clean { .. } => MemorySubcommand::Stats,
    }
}

/// Run a `memory` subcommand, routing Clean around the shared handler.
pub(crate) fn dispatch(subcmd: MemoryCommand) -> Result<()> {
    match subcmd {
        MemoryCommand::Clean { all_projects, yes } => run(all_projects, yes),
        other => commands::run_memory_command(map_memory_subcommand(other)),
    }
}

#[cfg(test)]
#[path = "memory_clean_tests.rs"]
mod memory_clean_tests;
