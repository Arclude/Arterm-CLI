import type { Tool } from "@arterm/core";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { multiEditTool } from "./multiEdit.js";
import { readTool } from "./read.js";
import { searchTool } from "./search.js";
import { taskDoneTool } from "./taskDone.js";
import { webFetchTool } from "./webFetch.js";
import { writeTool } from "./write.js";

/** The default tool set wired into the agent. */
export function defaultTools(): Tool[] {
  return [
    readTool,
    lsTool,
    globTool,
    grepTool,
    searchTool,
    writeTool,
    editTool,
    multiEditTool,
    bashTool,
    webFetchTool,
  ];
}

// taskDoneTool is intentionally NOT in defaultTools — the autonomy engine injects
// it only while a goal is running.
export {
  readTool,
  lsTool,
  globTool,
  grepTool,
  searchTool,
  writeTool,
  editTool,
  multiEditTool,
  bashTool,
  webFetchTool,
  taskDoneTool,
};
