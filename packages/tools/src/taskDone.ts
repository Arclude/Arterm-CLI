import type { Tool } from "@arterm/core";
import { optionalString } from "./paths.js";

/**
 * A no-op signal the model calls during an autonomous run to declare the goal
 * complete. The autonomy engine watches for this call to end the loop reliably
 * (far more robust than parsing free text for "done"). Harmless if never used.
 */
export const taskDoneTool: Tool = {
  name: "task_done",
  description:
    "Call this ONLY when the current goal is fully achieved, with a short summary of what was " +
    "accomplished. Ends the autonomous run.",
  permission: "allow",
  category: "read",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Short summary of what was accomplished." },
    },
    required: ["summary"],
  },
  async execute(args) {
    const summary = optionalString(args, "summary") ?? "";
    return { output: `✓ goal complete: ${summary}` };
  },
};
