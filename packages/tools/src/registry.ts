import type { Tool } from "@arterm/core";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { taskDoneTool } from "./taskDone.js";
import { writeTool } from "./write.js";

/** The default tool set wired into the agent. */
export function defaultTools(): Tool[] {
  return [readTool, lsTool, globTool, grepTool, writeTool, editTool, bashTool];
}

// taskDoneTool is intentionally NOT in defaultTools — the autonomy engine injects
// it only while a goal is running.
export { readTool, lsTool, globTool, grepTool, writeTool, editTool, bashTool, taskDoneTool };
