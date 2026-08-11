use anyhow::Result;
use clap::{Parser, Subcommand};

/// Arterm — local AI coding agent for your terminal.
#[derive(Parser)]
#[command(name = "arterm", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Print the version.
    Version,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Version) => {
            println!("arterm {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        None => {
            let config = arterm_config::load_config();
            let mut app = arterm_tui::App::new()?;
            let result = app.run(&config).await;
            let cleanup = app.cleanup();
            result?;
            cleanup?;
            Ok(())
        }
    }
}
