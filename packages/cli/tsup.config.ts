import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // Inline the workspace packages so the published `arterm-cli` is a single
  // self-contained binary. Third-party runtime deps (ink, react, execa, …) stay
  // external and are declared in this package's dependencies.
  noExternal: [/^@arterm\//],
});
