import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { keystorePaths } from "./keystore.js";

/**
 * The execution boundary `bash` runs inside.
 *
 * This file is the POLICY half — what the boundary is and where it comes from.
 * The MECHANISM half (bubblewrap/seatbelt, the egress proxy) lives in
 * `@arterm/tools`, behind the {@link SandboxRunner} seam declared here, because
 * `core` may not depend on any workspace package.
 *
 * The reason this exists at all is narrow and specific: `--autonomous` REMOVES
 * the only control we had — the permission prompt — and until now put nothing in
 * its place. `bash` runs on the host with the user's full identity, and yolo
 * clears it by construction. A permission ladder is a logical gate; it decides
 * whether a command runs. It has nothing to say about what a command that IS
 * allowed to run can then reach.
 */

/** Config shape for the sandbox (mirrors `ArtermConfig["sandbox"]`). */
export interface SandboxSettings {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowWrite?: string[];
  denyRead?: string[];
}

/** What the session knows at boot — the only legitimate source of a boundary. */
export interface SandboxSession {
  /** The session's working directory, fixed when the process started. */
  cwd: string;
  /** True for a run with nobody at the keyboard (`--autonomous`, headless). */
  unattended?: boolean;
}

/**
 * A resolved boundary: absolute, realpath'd, and closed over at boot.
 *
 * Every path here is derived from {@link SandboxSession} and config — never from
 * a tool call's arguments. That is the single most-repeated root cause in the
 * 2025–26 incident record: CVE-2025-59532 (Codex CLI) used the MODEL's `cwd` as
 * the sandbox's writable root, and Cursor's CVE-2026-50548 was the same bug
 * again. A boundary a tool call can name is not a boundary.
 */
export interface SandboxSpec {
  /** Absolute paths the sandboxed command may write. */
  writeRoots: string[];
  /** Absolute paths it may not read at all, whatever else it is granted. */
  denyRead: string[];
  /** Egress allowlist; an empty list means no network reaches out of `bash`. */
  allowedDomains: string[];
  /** Egress denials, applied over the allowlist (e.g. `"*:22"` for SSH). */
  deniedDomains: string[];
  /** When true, a sandbox that cannot be established stops the run. */
  failIfUnavailable: boolean;
}

/** A command rewritten to run inside the boundary. */
export interface SandboxedCommand {
  /** argv to spawn directly — NOT through a shell; the wrapper supplies its own. */
  argv: string[];
  env: Record<string, string | undefined>;
}

/**
 * The mechanism seam. Implemented in `@arterm/tools`, injected into
 * {@link ToolContext} by the agent, consumed by `bash`.
 */
export interface SandboxRunner {
  /** One line naming the boundary in force — for the startup banner. */
  readonly describe: string;
  /**
   * Rewrite `command` to run inside the boundary.
   *
   * Throws when `cwd` is outside the spec's write roots rather than silently
   * widening: the caller's directory is the one input that reaches this from
   * outside the boot-time spec, so it is checked, not trusted.
   */
  wrap(command: string, cwd: string, signal?: AbortSignal): Promise<SandboxedCommand>;
  /** Release per-command state (masked credential files, proxy leases). */
  release(): void;
  /**
   * Why a command that just FAILED might have failed because of this boundary,
   * or `undefined` when nothing in its output points here — see
   * {@link confinementNote}, which this delegates to.
   *
   * On the runner rather than in `ToolContext` because the spec is already
   * here: the context carries the runner, and a second copy of the boundary
   * beside it is a second thing that can disagree with the first. Optional for
   * the reason `dispose` is — a test double stays an object literal.
   */
  explain?(output: string): string | undefined;
  /**
   * Tear the boundary itself down at session end.
   *
   * Optional so a test double stays a three-line object literal, and mandatory
   * in spirit for anything backed by a real runtime: the boundary is not just
   * rules, it is HOST-SIDE PROCESSES AND LISTENERS (the egress proxy, the socket
   * bridge). Those handles hold Node's event loop open, so a run that has
   * finished still cannot exit. Observed exactly that way — a headless
   * `--autonomous` run wrote its result, printed its verdict, and then sat there
   * until an external timeout killed it, which reports as a failure with the
   * work already done. `release()` is per COMMAND; this is per SESSION.
   */
  dispose?(): Promise<void>;
}

/**
 * The egress allowlist a coding agent needs to be useful, and nothing else.
 *
 * Deny-all is the stronger boundary and the wrong default: a run that cannot
 * reach a package registry fails on its first `npm install`, and a sandbox
 * people switch off is worth less than a narrower one they leave on. What this
 * list buys is the property that matters — the lethal trifecta (private data +
 * untrusted content + an outbound channel) needs an ARBITRARY outbound channel,
 * and every entry here is a destination whose contents are already public.
 *
 * SSH is denied separately (`*:22`): it is the one protocol on this list that
 * carries a push, and an https remote is the reviewable alternative.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  // JS
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  "crates.io",
  "static.crates.io",
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Source hosts (https only — see deniedDomains below)
  "github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
];

/** Denials applied on top of the allowlist. */
export const DEFAULT_DENIED_DOMAINS: readonly string[] = ["*:22"];

/**
 * Turn config + session into a boundary, or `undefined` when the sandbox is off.
 *
 * `allowedDomains: []` in config is honored as written — deny-all egress — which
 * is why the default list lives in `defaultConfig()` rather than being OR'd in
 * here. A user who empties the list means it.
 *
 * The read denial is the one thing here that is a FLOOR rather than a default,
 * and the asymmetry is deliberate. `allowedDomains: []` has a meaning a user can
 * intend; "let the agent read my own API keys" has none, and unlike every other
 * entry in this file the denial costs no toolchain anything — no compiler, test
 * runner or `git` opens Arterm's keystore. Config adds to it and cannot empty it.
 */
export function resolveSandbox(
  settings: SandboxSettings | undefined,
  session: SandboxSession,
): SandboxSpec | undefined {
  if (!settings?.enabled) return undefined;
  const root = canonical(session.cwd);
  // The temp dir is not a courtesy: build tools, test runners and package
  // managers all write there, and a sandbox that fails every `npm test` gets
  // switched off within the hour.
  const writeRoots = unique([root, canonical(tmpdir()), ...absolutize(settings.allowWrite, root)]);
  return {
    writeRoots,
    denyRead: unique([...keystorePaths(), ...absolutize(settings.denyRead, root)]),
    allowedDomains: [...(settings.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)],
    deniedDomains: [...(settings.deniedDomains ?? DEFAULT_DENIED_DOMAINS)],
    // Unattended is the case that has to fail closed. Nobody is there to read a
    // warning, and the run is about to be handed yolo permissions for hours.
    failIfUnavailable: settings.failIfUnavailable ?? session.unattended === true,
  };
}

/**
 * True when `dir` is inside one of the spec's write roots.
 *
 * Compared after `realpath` on BOTH sides — a prefix test on unresolved paths is
 * defeated by a symlink, which is how `/proc/self/root/...` walked out of a
 * bubblewrap jail in the incident record.
 */
export function withinWriteRoots(spec: SandboxSpec, dir: string): boolean {
  const target = canonical(dir);
  // `sep`, not "/": on Windows a resolved path is separated by backslashes, so a
  // hardcoded slash makes the prefix test never match and every command inside
  // the boundary gets refused. The separator is what keeps `/work/project-evil`
  // from passing as `/work/project`, so it has to be the real one.
  return spec.writeRoots.some((root) => target === root || target.startsWith(`${root}${sep}`));
}

/** One line describing the boundary, for the banner and for `--autonomous`. */
export function describeSandbox(spec: SandboxSpec): string {
  const net =
    spec.allowedDomains.length === 0
      ? "no network"
      : `${spec.allowedDomains.length} allowed domain${spec.allowedDomains.length === 1 ? "" : "s"}`;
  return `writes confined to ${spec.writeRoots.join(", ")}; egress: ${net}`;
}

/**
 * Paths a refusal never explains anything about.
 *
 * Every error line names an interpreter — `/usr/bin/bash: line 1: …` — and
 * `/usr/bin/bash` is outside the write roots, so without this the note would
 * fire on every failing command and point at the shell. These are also places a
 * write already fails for an ordinary user with no sandbox in sight, so
 * excluding them costs the diagnosis nothing it could have said.
 */
const UNINFORMATIVE_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib",
  "/opt/",
  "/etc/",
  "/proc/",
  "/sys/",
  "/dev/",
];

/** Absolute paths named in text: POSIX `/a/b`, and Windows `C:\a\b`. */
function pathsIn(text: string): string[] {
  const posix = text.match(/(?<![\w.])\/[^\s:;,"'`)\]]+/g) ?? [];
  const win = text.match(/(?<![\w])[A-Za-z]:\\[^\s:;,"'`)\]]+/g) ?? [];
  return unique([...posix, ...win].map((p) => p.replace(/[.,)]+$/, "")));
}

/**
 * Why a command that just FAILED might have failed because it was confined.
 *
 * The same shape as `withheldNote` one file over, and the same shape as the
 * post-failure diagnosis in WrongStack's shell tool, for the same three
 * reasons: it is **failure-coupled** (a command that succeeded was not stopped
 * by anything), it is **advisory** (it never blocks, mutates or retries), and
 * it returns `undefined` when it has nothing specific to say. A note appended
 * to every failing command in a confined session is one the model learns to
 * ignore, and it would attribute a failing test suite to the sandbox.
 *
 * The reason it exists is what the boundary looks like from the inside. A
 * refused write surfaces as the KERNEL's message and nothing else —
 * `Read-only file system`, `[exit code 1]` — with no mention of Arterm, so the
 * model's next move is `sudo`, or another path, or telling the user their disk
 * is broken. Confinement that reads as breakage is worse than confinement that
 * explains itself, and the explanation has to reach the MODEL, not just the
 * screen: it is the model that decides what to do next.
 *
 * Evidence is the OUTPUT, never the command. A command names the paths it
 * intends to touch (`cd /tmp && …`) and would make this fire whenever any of
 * them appeared in a failure with another cause; the output names the path the
 * write actually died on. That also keeps it locale-independent — it matches
 * PATHS, not `Read-only file system`, which arrives translated on a Turkish
 * host and would silently never match.
 */
export function confinementNote(
  spec: SandboxSpec | undefined,
  output: string,
  limit = 2,
): string | undefined {
  if (!spec) return undefined;
  const named = pathsIn(output);
  const denied = named.filter((p) => spec.denyRead.some((d) => p === d || p.startsWith(`${d}/`)));
  const outside = named.filter(
    (p) =>
      !denied.includes(p) &&
      !UNINFORMATIVE_PREFIXES.some((prefix) => p.startsWith(prefix)) &&
      !withinWriteRoots(spec, p),
  );
  // The proxy's refusal is OUR message, so unlike the kernel's it is stable
  // text — but only worth mentioning when egress is actually restricted.
  const blockedHost = /\bproxy\b/i.test(output) && spec.allowedDomains.length > 0;
  if (denied.length === 0 && outside.length === 0 && !blockedHost) return undefined;

  const parts: string[] = [];
  if (denied.length > 0) {
    parts.push(
      `${denied.slice(0, limit).join(", ")} is Arterm's own key material and is never readable`,
    );
  }
  if (outside.length > 0) {
    parts.push(
      `${outside.slice(0, limit).join(", ")} is outside the writable roots (${spec.writeRoots.join(", ")})`,
    );
  }
  if (blockedHost && outside.length === 0 && denied.length === 0) {
    parts.push(
      `network egress is limited to ${spec.allowedDomains.length} allowed host${
        spec.allowedDomains.length === 1 ? "" : "s"
      }, and everything else is refused by a proxy`,
    );
  }
  const advice =
    "Work inside the project directory or the temp dir, or ask the user to rerun with " +
    "--no-sandbox — retrying the same path will fail the same way.";
  return `[Arterm ran this command inside a sandbox: ${parts.join("; ")}. ${advice}]`;
}

/** Resolve to an absolute, symlink-free path; fall back to the plain resolve. */
function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Not yet created (a temp root, a worktree about to be cut) — the string
    // form is still the right boundary; it just cannot be proven yet.
    return abs;
  }
}

function absolutize(paths: string[] | undefined, root: string): string[] {
  return (paths ?? []).map((p) => canonical(isAbsolute(p) ? p : resolve(root, p)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
