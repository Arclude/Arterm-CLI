/**
 * Running git for the tools that need its exit code and streams separately.
 *
 * `git.ts` has its own runner that formats a result for the model; `diff` and
 * `patch` need the raw stdout (it IS the artifact) and stderr (it names the
 * hunk that failed) apart from each other.
 *
 * The environment is scrubbed for the reason `credentials.ts` states: git is
 * not an inert program. A repository's own config can point `diff.<driver>.command`
 * or a textconv filter at any executable, which then runs with whatever we
 * handed git — and what the agent process holds is the user's API keys. No
 * egress rule covers that path, because the command is ours.
 */

import { type CredentialSettings, scrubEnv } from "@arterm/core";

export interface GitRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

export async function runGit(
  args: string[],
  cwd: string,
  opts: { input?: string; signal?: AbortSignal; credentials?: CredentialSettings } = {},
): Promise<GitRun> {
  const { execa } = await import("execa");
  // git translates its own messages, so on a Turkish or German machine the
  // stderr a tool reports back to the model — and any check written against
  // it — is in that language. Pinning the locale makes the text one thing
  // everywhere; it is also the language git's own documentation is in, which
  // is what the model has actually read.
  const { env } = scrubEnv({ ...process.env, LC_ALL: "C", LANG: "C" }, opts.credentials);
  const result = await execa("git", args, {
    cwd,
    shell: false,
    reject: false,
    env,
    extendEnv: false,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.signal ? { cancelSignal: opts.signal } : {}),
  });
  const exitCode = result.exitCode ?? 1;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode,
    ok: exitCode === 0,
  };
}

/** True when `cwd` sits inside a git work tree. */
export async function inGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, { signal });
  return r.ok && r.stdout.trim() === "true";
}
