//! Repo map: a token-efficient, repo-wide map of files and their top symbols.
//!
//! Aider showed the value of giving the model a whole-repository overview
//! instead of forcing blind grep. This tool walks the working directory
//! (respecting ignores), renders a compact directory tree annotated with
//! file sizes, and appends per-file structure outlines (top-level symbols
//! with line spans) for the largest/most central source files.
//!
//! Output shape (schematic):
//!
//! ```text
//! repo-map: 312 files, 41 outlined (root: /home/x/proj)
//! crates/
//!   core/
//!     mod.rs            420L   fn run, struct Engine
//!     policy.rs         180L   struct Policy, enum Action
//! ...
//! outlined symbols
//!   crates/core/mod.rs (420L)
//!     1-88   fn run
//!     90-150 struct Engine
//! ```
//!
//! The tree is breadth-first and bounded ([`MAX_TREE_ENTRIES`]), outlines are
//! ranked by a simple centrality heuristic (line count × source-file bonus)
//! and bounded by [`MAX_OUTLINED_FILES`]. The whole call is read-only and
//! plan-mode safe.

use anyhow::Result;
use serde_json::Value;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};

use super::{Tool, ToolContext, ToolOutput};

const MAX_TREE_ENTRIES: usize = 400;
const MAX_OUTLINED_FILES: usize = 40;
const MAX_OUTLINE_ITEMS_PER_FILE: usize = 8;
/// Directories that are never interesting in a source map.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "vendor",
    ".cache",
];
/// Extensions whose files get structure outlines.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "py", "ts", "tsx", "js", "jsx", "go", "java", "c", "h", "cpp", "hpp", "rb",
];

pub struct RepoMapTool;

impl RepoMapTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Debug, serde::Deserialize)]
struct RepoMapInput {
    /// Directory to map. Defaults to the session working directory.
    #[serde(default)]
    path: Option<String>,
    /// Maximum tree entries to include (default 400, capped at 1000).
    #[serde(default)]
    max_entries: Option<usize>,
    /// Skip the per-file symbol outlines (tree only).
    #[serde(default)]
    tree_only: Option<bool>,
}

#[async_trait::async_trait]
impl Tool for RepoMapTool {
    fn name(&self) -> &str {
        "repo_map"
    }

    fn description(&self) -> &str {
        "Directory tree with line counts plus symbol outlines. Read-only."
    }

    fn parameters_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory to map. Defaults to the working directory."
                },
                "max_entries": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000,
                    "description": "Maximum tree entries to include (default 400)."
                },
                "tree_only": {
                    "type": "boolean",
                    "description": "Skip the per-file symbol outlines and return only the annotated tree."
                },
                "intent": {
                    "type": "string",
                    "description": "Required short label shown in the UI: why this call is being made."
                }
            },
            "required": ["intent"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input: RepoMapInput = serde_json::from_value(input)
            .map_err(|e| anyhow::anyhow!("invalid repo_map input: {e}"))?;
        let explicit_path = input.path.clone().filter(|p| !p.trim().is_empty());
        let root = explicit_path
            .map(PathBuf::from)
            .or_else(|| ctx.working_dir.clone())
            .unwrap_or_else(|| PathBuf::from("."));
        let max_entries = input.max_entries.unwrap_or(MAX_TREE_ENTRIES).min(1000);
        let tree_only = input.tree_only.unwrap_or(false);

        let entries = collect_files(&root, max_entries)?;
        if entries.is_empty() {
            return Ok(ToolOutput::new(format!(
                "repo-map: no source files found under {} (is the path right?)",
                root.display()
            )));
        }

        let mut out = String::new();
        out.push_str(&format!(
            "repo-map: {} files (root: {})\n",
            entries.len(),
            root.display()
        ));

        // Render tree grouped by directory.
        let mut by_dir: std::collections::BTreeMap<PathBuf, Vec<&FileEntry>> =
            std::collections::BTreeMap::new();
        for e in &entries {
            by_dir
                .entry(e.path.parent().unwrap_or(Path::new("")).to_path_buf())
                .or_default()
                .push(e);
        }
        let outlined_dirs: std::collections::HashSet<&Path> = if tree_only {
            Default::default()
        } else {
            rank_outline_candidates(&entries)
                .iter()
                .map(|e| e.path.as_path())
                .collect()
        };
        for (dir, files) in &by_dir {
            let rel_dir = dir.strip_prefix(&root).unwrap_or(dir);
            let dir_label = if rel_dir.as_os_str().is_empty() {
                ".".to_string()
            } else {
                format!("{}/", rel_dir.display())
            };
            out.push_str(&format!("{dir_label}\n"));
            for f in files {
                let symbols = if outlined_dirs.contains(f.path.as_path()) {
                    " ◆ outlined below"
                } else {
                    ""
                };
                out.push_str(&format!(
                    "  {:<32} {:>6}L{}\n",
                    f.path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    f.lines,
                    symbols
                ));
            }
        }

        if !tree_only {
            let candidates = rank_outline_candidates(&entries);
            out.push_str("\noutlined symbols\n");
            for entry in candidates {
                let Some(outline) = outline_file(&root, entry) else {
                    continue;
                };
                out.push_str(&format!(
                    "\n{} ({}L)\n",
                    entry
                        .path
                        .strip_prefix(&root)
                        .unwrap_or(&entry.path)
                        .display(),
                    entry.lines
                ));
                out.push_str(&outline);
            }
        }

        Ok(ToolOutput::new(out))
    }
}

struct FileEntry {
    path: PathBuf,
    lines: usize,
    is_source: bool,
}

/// Walk the tree breadth-first, skipping heavy/irrelevant directories, until
/// `max_entries` files are collected.
fn collect_files(root: &Path, max_entries: usize) -> Result<Vec<FileEntry>> {
    let mut entries = Vec::new();
    let mut queue: std::collections::VecDeque<PathBuf> = std::collections::VecDeque::new();
    queue.push_back(root.to_path_buf());
    while let Some(dir) = queue.pop_front()
        && entries.len() < max_entries
    {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = read_dir.flatten().map(|e| e.path()).collect();
        children.sort();
        for child in children {
            if entries.len() >= max_entries {
                break;
            }
            let name = child
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.starts_with('.') && name != ".github" {
                continue;
            }
            if child.is_dir() {
                if SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                queue.push_back(child);
            } else if let Some(entry) = file_entry(&child) {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

fn file_entry(path: &Path) -> Option<FileEntry> {
    let Ok(meta) = std::fs::metadata(path) else {
        return None;
    };
    if meta.len() > 1_000_000 {
        return None; // Skip huge files; they are rarely source.
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_source = SOURCE_EXTENSIONS.contains(&ext.as_str());
    let lines = std::fs::read_to_string(path)
        .map(|text| text.lines().count())
        .unwrap_or(0);
    Some(FileEntry {
        path: path.to_path_buf(),
        lines,
        is_source,
    })
}

/// Rank which files deserve symbol outlines: source files by line count
/// (bigger = more central), bounded to [`MAX_OUTLINED_FILES`].
fn rank_outline_candidates(entries: &[FileEntry]) -> Vec<&FileEntry> {
    #[derive(PartialEq, Eq)]
    struct Ranked(usize, usize); // (lines, idx) max-heap by lines
    impl Ord for Ranked {
        fn cmp(&self, other: &Self) -> std::cmp::Ordering {
            self.0.cmp(&other.0).then(other.1.cmp(&self.1))
        }
    }
    impl PartialOrd for Ranked {
        fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(other))
        }
    }

    let mut heap: BinaryHeap<Ranked> = BinaryHeap::new();
    for (idx, e) in entries.iter().enumerate() {
        if e.is_source && e.lines > 0 {
            heap.push(Ranked(e.lines, idx));
        }
    }
    let mut picked: Vec<usize> = heap
        .into_sorted_vec()
        .into_iter()
        .take(MAX_OUTLINED_FILES)
        .map(|r| r.1)
        .collect();
    picked.sort(); // Stable path order for readable output.
    picked.into_iter().map(|i| &entries[i]).collect()
}

/// Outline one file via agentgrep's structure extraction, capped at
/// [`MAX_OUTLINE_ITEMS_PER_FILE`] items.
fn outline_file(root: &Path, entry: &FileEntry) -> Option<String> {
    let rel = entry.path.strip_prefix(root).unwrap_or(&entry.path);
    let args = agentgrep::cli::OutlineArgs {
        file: rel.display().to_string(),
        json: false,
        max_items: Some(MAX_OUTLINE_ITEMS_PER_FILE),
        path: Some(root.display().to_string()),
        context_json: None,
    };
    let result = agentgrep::outline::run_outline(root, &args).ok()?;
    let mut out = String::new();
    for item in result
        .structure
        .items
        .iter()
        .take(MAX_OUTLINE_ITEMS_PER_FILE)
    {
        out.push_str(&format!(
            "  {:>5}-{:<5} {} {}\n",
            item.start_line, item.end_line, item.kind, item.label
        ));
    }
    if result.structure.omitted_count > 0 {
        out.push_str(&format!(
            "  … {} more symbols omitted\n",
            result.structure.omitted_count
        ));
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_for(dir: &Path) -> ToolContext {
        ToolContext {
            session_id: "test".to_string(),
            message_id: "test".to_string(),
            tool_call_id: "test".to_string(),
            working_dir: Some(dir.to_path_buf()),
            stdin_request_tx: None,
            graceful_shutdown_signal: None,
            execution_mode: crate::tool::ToolExecutionMode::Direct,
            sandbox_mode: "full-access".to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn maps_tree_and_outlines_rust_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n\nstruct Engine {\n    x: u32,\n}\n\nimpl Engine {\n    fn run(&self) {}\n}\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("README.md"), "# readme\n").unwrap();

        let out = RepoMapTool
            .execute(
                serde_json::json!({"intent": "orient in test repo"}),
                ctx_for(tmp.path()),
            )
            .await
            .unwrap();
        assert!(out.output.contains("repo-map: 2 files"), "{}", out.output);
        assert!(out.output.contains("main.rs"), "{}", out.output);
        assert!(
            out.output.contains("outlined symbols"),
            "rust file must get an outline: {}",
            out.output
        );
        assert!(
            out.output.contains("fn main") || out.output.contains("main"),
            "{}",
            out.output
        );
    }

    #[tokio::test]
    async fn tree_only_skips_outlines() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("lib.rs"), "pub fn a() {}\npub fn b() {}\n").unwrap();
        let out = RepoMapTool
            .execute(
                serde_json::json!({"intent": "quick tree", "tree_only": true}),
                ctx_for(tmp.path()),
            )
            .await
            .unwrap();
        assert!(!out.output.contains("outlined symbols"), "{}", out.output);
    }

    #[tokio::test]
    async fn skips_heavy_directories() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("node_modules")).unwrap();
        std::fs::write(tmp.path().join("node_modules").join("junk.js"), "var x;\n").unwrap();
        std::fs::write(tmp.path().join("app.py"), "def main():\n    pass\n").unwrap();

        let out = RepoMapTool
            .execute(
                serde_json::json!({"intent": "check ignores"}),
                ctx_for(tmp.path()),
            )
            .await
            .unwrap();
        assert!(!out.output.contains("node_modules"), "{}", out.output);
        assert!(out.output.contains("app.py"), "{}", out.output);
    }
}
