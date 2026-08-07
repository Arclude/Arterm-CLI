/**
 * What the tool roster costs, per tool and per tier.
 *
 * The tiers exist to save tokens, and a claim about how many is worth nothing
 * without the measurement behind it. This is that measurement: every tool's
 * name, description, selection hint and parameter schema — the bytes that
 * actually go on the wire, on every single request — run through the same
 * estimator the compaction decision uses.
 *
 * The per-tool list is sorted by cost because the question it answers is
 * "what should I cut", and the answer is always at the top.
 */

import { type ToolTier, defaultTools, tierCost, toolSchemaTokens } from "@arterm/tools";

const TIERS: ToolTier[] = ["minimal", "standard", "full"];

export function runToolsCost(opts: { tier?: string; json?: boolean }): void {
  const requested = TIERS.find((t) => t === opts.tier);
  if (opts.tier && !requested) {
    process.stderr.write(`unknown tier "${opts.tier}" — expected ${TIERS.join(" | ")}\n`);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    const payload = {
      tiers: Object.fromEntries(
        TIERS.map((tier) => {
          const cost = tierCost(tier);
          return [tier, { tools: cost.tools.length, tokens: cost.total }];
        }),
      ),
      tools: defaultTools("full")
        .map((t) => ({
          name: t.name,
          tokens: toolSchemaTokens(t),
          tiers: TIERS.filter((tier) => defaultTools(tier).some((x) => x.name === t.name)),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const tier = requested ?? "full";
  const { tools, total } = tierCost(tier);
  const width = Math.max(...tools.map((t) => t.name.length));

  process.stdout.write(`roster cost — ${tier} (${tools.length} tools)\n\n`);
  for (const t of tools) {
    process.stdout.write(`  ${t.name.padEnd(width)}  ${String(t.tokens).padStart(5)} tokens\n`);
  }
  process.stdout.write(`  ${"".padEnd(width)}  ${"".padStart(5, "-")}\n`);
  process.stdout.write(`  ${"total".padEnd(width)}  ${String(total).padStart(5)} tokens\n\n`);

  // The comparison is the point: a tier is only worth choosing if you can see
  // what it saves, on every request, for the whole session.
  if (!requested) {
    const full = tierCost("full").total;
    for (const t of TIERS) {
      const cost = tierCost(t);
      const saved = full - cost.total;
      const pct = full > 0 ? Math.round((saved / full) * 100) : 0;
      const delta = saved > 0 ? `  (−${saved}, ${pct}% less than full)` : "";
      process.stdout.write(
        `  ${t.padEnd(9)} ${String(cost.tools.length).padStart(2)} tools  ${String(cost.total).padStart(5)} tokens${delta}\n`,
      );
    }
    process.stdout.write("\n  set it with `tools.tier` in ~/.arterm/config.json\n");
  }

  // Said plainly rather than left to be discovered: a session adds tools this
  // command cannot see (they need stores and callbacks that only exist inside
  // a run), so the real roster is larger than the number above. A measurement
  // that quietly excludes part of what it measures is the kind of number
  // people plan against and then find wrong.
  process.stdout.write(
    "\n  not counted: tools a session adds at runtime — todo, plan, task, spawn,\n" +
      "  spawn_parallel, the model-driven fleet (spawn_subagent, assign_task,\n" +
      "  await_tasks, ask_subagent, roll_up, fleet), the memory tools, and any\n" +
      "  MCP or plugin tools.\n",
  );
}
