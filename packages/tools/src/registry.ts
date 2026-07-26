import type { Tool } from "@arterm/core";
import { bashTool } from "./bash.js";
import { batchTool } from "./batch.js";
import { editTool } from "./edit.js";
import { gitCommitTool, gitTool } from "./git.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { multiEditTool } from "./multiEdit.js";
import { formatTool, lintTool, testTool } from "./project.js";
import { readTool } from "./read.js";
import { searchTool } from "./search.js";
import { submitVerdictTool } from "./submitVerdict.js";
import { symbolsTool } from "./symbols.js";
import { taskDoneTool } from "./taskDone.js";
import { toolSearchTool } from "./toolSearch.js";
import { webFetchTool } from "./webFetch.js";
import { webSearchTool } from "./webSearch.js";
import { writeTool } from "./write.js";

/** The default tool set wired into the agent. */
export function defaultTools(): Tool[] {
  return [
    readTool,
    lsTool,
    globTool,
    grepTool,
    searchTool,
    symbolsTool,
    writeTool,
    editTool,
    multiEditTool,
    bashTool,
    webFetchTool,
    webSearchTool,
    gitTool,
    gitCommitTool,
    testTool,
    lintTool,
    formatTool,
    toolSearchTool,
    batchTool,
  ];
}

// taskDoneTool and submitVerdictTool are intentionally NOT in defaultTools — both
// are injected as a run's terminal tool (a goal's, a review's) rather than being
// ambient, which also keeps them off the `permissions list` / `explain` surface.
export {
  readTool,
  lsTool,
  globTool,
  grepTool,
  searchTool,
  symbolsTool,
  writeTool,
  editTool,
  multiEditTool,
  bashTool,
  webFetchTool,
  webSearchTool,
  gitTool,
  gitCommitTool,
  testTool,
  lintTool,
  formatTool,
  toolSearchTool,
  batchTool,
  taskDoneTool,
  submitVerdictTool,
};
