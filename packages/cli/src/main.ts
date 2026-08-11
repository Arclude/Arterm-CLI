/**
 * The launcher, and it exists for exactly one line.
 *
 * React ships two builds and picks between them at IMPORT time, by reading
 * `process.env.NODE_ENV`. Unset, it loads the development build — extra
 * validation on every element, `defineKeyPropWarningGetter` on every prop, a
 * slower reconciler — which is what every user was running, because nothing set
 * it. Measured against the built binary on a 1,200-chunk stream in fullscreen:
 * **2,390ms of CPU unset versus 1,940ms with it set**, same frame count, same
 * output. Nineteen percent of a streaming turn, for a variable.
 *
 * It cannot be done in `app.ts`, and this file is the whole reason: ESM hoists
 * imports, so every `import` in a module is evaluated BEFORE the module's first
 * statement. By the time any line of `app.ts` runs, Ink has already imported
 * React and React has already chosen. A tsup `banner` fails for the same reason
 * — it is prepended to the module body, not ahead of its imports. Only a
 * separate entry with a DYNAMIC import can set the variable first, which is why
 * `app.ts` is reached through `await import` below and not through `import`.
 *
 * `??=`, never `=`: a user who exported `NODE_ENV=development` to debug
 * something meant it, and a launcher that overrode them would be a tool
 * silently disagreeing with its operator.
 *
 * **And what we set, we do not hand on.** `NODE_ENV=production` in a spawned
 * command's environment makes npm, yarn and pnpm skip devDependencies — so an
 * agent running `npm install` would produce a subtly wrong tree, for a reason
 * nobody could see. `scrubEnv` removes it again on the way out, but ONLY when it
 * was defaulted here; a value the user exported themselves is theirs and is
 * passed through untouched. The marker is a well-known symbol on `globalThis`
 * rather than an environment variable, because an environment variable is the
 * one thing that would leak into the very children this is protecting.
 *
 * Nothing is imported above this line on purpose. An import here would be
 * evaluated before the assignment and could pull React in behind our back.
 */
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = "production";
  (globalThis as Record<symbol, unknown>)[Symbol.for("arterm.nodeEnvDefaulted")] = true;
}

await import("./app.js");

// A file with no static import or export is a SCRIPT to TypeScript, and a
// script may not use top-level `await` — which is the one thing this file is
// for. Declaring it a module costs nothing at runtime and keeps the dynamic
// import dynamic, which a real `import` statement would not.
export {};
