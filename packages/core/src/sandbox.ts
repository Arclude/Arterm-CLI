import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

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
    denyRead: unique(absolutize(settings.denyRead, root)),
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
  return spec.writeRoots.some((root) => target === root || target.startsWith(`${root}/`));
}

/** One line describing the boundary, for the banner and for `--autonomous`. */
export function describeSandbox(spec: SandboxSpec): string {
  const net =
    spec.allowedDomains.length === 0
      ? "no network"
      : `${spec.allowedDomains.length} allowed domain${spec.allowedDomains.length === 1 ? "" : "s"}`;
  return `writes confined to ${spec.writeRoots.join(", ")}; egress: ${net}`;
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
