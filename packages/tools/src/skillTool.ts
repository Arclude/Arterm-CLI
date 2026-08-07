/**
 * The `skill` tool: the model loading the project's own instructions by name.
 *
 * A skill is reachable only through the user's `/skill <name>`, which puts the
 * decision in the wrong hands. The participant who can tell that the task in
 * front of it matches "how we write migrations here" is the model, mid-task —
 * and it is the one participant that could see the skill listed in its system
 * prompt (`skillsPromptSection`) and not fetch it. Everything here is the
 * existing `SkillRegistry`; the tool is the missing door.
 */
import type { Tool } from "@arterm/core";
import { optionalString } from "./paths.js";
import type { Skill, SkillRegistry } from "./skills.js";

/**
 * A skill is an instruction document, and the central clamp cuts the MIDDLE. On
 * prose the middle is repetition; on a numbered procedure it is steps 4 through
 * 9, and the marker left behind reports bytes, not which instructions went with
 * them. So the ceiling sits where a hand-written skill fits whole — past it the
 * text is a document rather than a skill, and it degrades to a head, a tail and
 * the path of the spooled file, which the model can `read` in full.
 */
const MAX_OUTPUT = 65_536;

/**
 * Exact name first, then one case-insensitive pass.
 *
 * The registry keys on whatever the frontmatter said, so a skill written as
 * "Code Review" is unreachable from the obvious `code-review` guess and a
 * near-miss costs a round trip to discover. Matching loosely is not guessing:
 * the candidate set is the handful of files the user installed themselves.
 */
function findSkill(registry: SkillRegistry, requested: string): Skill | undefined {
  const exact = registry.get(requested);
  if (exact) return exact;
  const wanted = requested.toLowerCase();
  const match = registry.list().find((s) => s.name.toLowerCase() === wanted);
  return match ? registry.get(match.name) : undefined;
}

/** One line per skill, in the registry's sorted order. */
function renderList(registry: SkillRegistry): string {
  return registry
    .list()
    .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

/**
 * Builds the `skill` tool over an already-loaded {@link SkillRegistry}. The
 * registry is injected rather than constructed here so the tool reads the same
 * skills `/skill` and the system prompt do — one `load()`, one view of what
 * exists.
 */
export function createSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "skill",
    maxOutputBytes: MAX_OUTPUT,
    description:
      "Load a skill — the project's own written instructions for a kind of task — by name, and " +
      "get its full text. Call with no arguments to list what is available. Load one when the " +
      "task at hand matches its description; its instructions then apply for the rest of the task.",
    usageHint:
      "List first when you are unsure of the exact name — a wrong name costs a call, and the " +
      "names in your system prompt are the ones that work. Load a skill BEFORE starting the work " +
      "it describes, not after: its whole value is telling you how this project wants the thing " +
      "done, which is worth nothing once you have done it another way. Loading the same skill " +
      "twice adds nothing; the text stays in the conversation.",
    // Reading a markdown file the USER put in their own skills directory: no
    // network, no mutation, nothing outside the one directory the registry was
    // pointed at. "allow"/"read" for the same reason `submit_verdict` is both:
    // plan mode denies every non-read category and a sub-agent's asker answers
    // "deny", so anything stricter would remove the project's own conventions
    // from planning and from delegated work — the two places a worker with no
    // memory of the project needs them most.
    //
    // The model supplies a NAME, not a PATH. `registry.get` is a Map lookup over
    // what `load()` already read from one directory, so there is no traversal
    // surface to confine: the boundary belongs to the loader and was never
    // derived from model output, which is the property CLAUDE.md keeps insisting
    // on and the one the CVEs it cites gave away.
    permission: "allow",
    category: "read",
    mutating: false,
    riskTier: "safe",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill to load. Omit to list every available skill.",
        },
      },
    },
    preview: (args) => {
      const name = optionalString(args, "name")?.trim();
      return name ? `load skill "${name}"` : "list skills";
    },
    async execute(args) {
      // An empty string is treated as "not given": a model that fills every
      // declared property reaches for `{ name: "" }`, and answering that with
      // "no skill named ''" teaches it nothing it can act on.
      const requested = optionalString(args, "name")?.trim();
      const count = registry.size;

      if (!requested) {
        if (count === 0) {
          return { output: "No skills are installed. Add markdown files to the skills directory." };
        }
        return {
          output: `${count} skill(s) available:\n${renderList(registry)}\n\nLoad one with skill(name).`,
        };
      }

      const skill = findSkill(registry, requested);
      if (!skill) {
        // The available names go IN the failure. A model that guessed one name
        // guesses again given nothing, and the list is a few short lines — far
        // cheaper than the extra call, and it makes the retry the obvious move
        // rather than a second guess.
        const known =
          count === 0 ? "No skills are installed." : `Available:\n${renderList(registry)}`;
        return { output: `No skill named "${requested}". ${known}`, isError: true };
      }
      if (!skill.body.trim()) {
        // A skill file that is all frontmatter parses fine and loads to nothing.
        // Returning that emptily reads as "loaded, and it said to do nothing",
        // which is the one interpretation that is certainly wrong.
        return {
          output: `Skill "${skill.name}" has an empty body — its file carries frontmatter and no instructions.`,
          isError: true,
        };
      }

      // The header is provenance, and it is what makes the body legible as a
      // directive. Handed back bare, an instruction document arrives as an
      // anonymous block of tool output — material to summarise rather than
      // orders to follow — and the transcript keeps no record of which skill
      // changed the model's behaviour halfway through a task.
      const head = `Skill "${skill.name}"${skill.description ? ` — ${skill.description}` : ""}`;
      return {
        output: `${head}\nThese are the project's own instructions. Follow them for this task.\n\n${skill.body}`,
      };
    },
  };
}
