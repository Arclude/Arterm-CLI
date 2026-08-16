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

use anyhow::{Context, Result};

use crate::cli::args::MemoryCommand;
use crate::cli::commands::{self, MemorySubcommand};
use crate::memory::MemoryManager;
// The delete itself lives in arterm-base so the TUI's `/memory clean` removes
// exactly the same files this does.
use crate::memory_clean::{clear_projects_dir, projects_dir, remove_store_at};

/// Run `arterm memory clean`.
pub(crate) fn run(all_projects: bool, yes: bool) -> Result<()> {
    if all_projects {
        if !yes && !confirm("every project's memory on this machine")? {
            println!("Nothing was cleaned.");
            return Ok(());
        }
        let dir = projects_dir()?;
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
    // Scope the manager to this directory. A bare `MemoryManager::new()` has
    // `project_dir: None`, so `project_memory_path` returns None and the clean
    // reported "nothing to clean" for every project that had a store — the
    // command's default path could never delete anything. The store is keyed on
    // the session working dir when written (see `turn_memory`), and the CLI's
    // equivalent is where it was invoked.
    let project_dir = std::env::current_dir().context("finding the current directory")?;
    let cleaned = match MemoryManager::new()
        .with_project_dir(project_dir)
        .project_memory_path()?
    {
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
