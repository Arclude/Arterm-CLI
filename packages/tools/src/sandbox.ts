import type { SandboxRunner, SandboxSpec } from "@arterm/core";
import { describeSandbox, withinWriteRoots } from "@arterm/core";

/**
 * The MECHANISM half of the sandbox — see `core/src/sandbox.ts` for the policy.
 *
 * Backed by `@anthropic-ai/sandbox-runtime` (bubblewrap + seccomp on Linux,
 * Seatbelt on macOS, WFP on Windows), which is what buys the part we cannot
 * write ourselves: an egress ALLOWLIST rather than an on/off switch. A network
 * namespace gives "no network"; a per-destination allowlist needs a host-side
 * proxy the sandboxed process cannot reconfigure, and that proxy is the whole
 * reason to take a dependency here instead of shelling out to `bwrap` directly.
 *
 * Loaded lazily. It starts proxies and resolves binaries on `initialize()`, so
 * a session that never enables the sandbox must never pay for it — the same
 * reason `bash` imports execa on first use rather than at startup.
 */

/** Either a working boundary, or the reason there isn't one. */
export type SandboxAttempt =
  | { ok: true; runner: SandboxRunner; warnings?: string[] }
  | { ok: false; reason: string };

/**
 * Boundaries established in this process, keyed by the spec that produced them.
 *
 * `holders` is what makes teardown safe: one process can hand the SAME boundary
 * to several sessions (the TUI's manager does), and they close on their own
 * schedules. Resetting on the first close would unconfine the sessions still
 * running, so the last holder out is the one that tears the proxies down.
 */
const established = new Map<string, { runner: SandboxRunner; holders: number }>();

/** Minimal view of the vendor API — kept narrow so the seam stays inspectable. */
interface VendorManager {
  isSupportedPlatform(): boolean;
  initialize(config: unknown): Promise<void>;
  checkDependenciesAsync(): Promise<{ warnings: string[]; errors: string[] }>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    cwd?: string,
  ): Promise<{ argv: string[]; env: Record<string, string | undefined> }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

/**
 * Establish the boundary, or say why not.
 *
 * Never throws: an unavailable sandbox is a decision the CALLER has to make
 * (warn and continue when someone is watching, refuse when nobody is), and a
 * throw here would collapse those two into one. `spec.failIfUnavailable`
 * carries which it is; this function only reports.
 */
export async function createSandboxRunner(spec: SandboxSpec): Promise<SandboxAttempt> {
  // The vendor's SandboxManager is a module singleton that owns real host-side
  // processes (the egress proxy, the socket bridges). One CLI process can build
  // several sessions — the TUI's session manager does — and initializing it a
  // second time would rebind those. Every session in a process shares one cwd,
  // so the boundary is identical too; memoizing on the spec makes that explicit
  // rather than depending on it silently.
  const key = JSON.stringify(spec);
  const cached = established.get(key);
  if (cached) {
    cached.holders += 1;
    return { ok: true, runner: cached.runner };
  }
  if (established.size > 0) {
    return {
      ok: false,
      reason:
        "a different sandbox boundary is already active in this process " +
        "(the sandbox runtime is process-global, so it cannot hold two)",
    };
  }

  let manager: VendorManager;
  try {
    const mod = (await import("@anthropic-ai/sandbox-runtime")) as {
      SandboxManager: VendorManager;
    };
    manager = mod.SandboxManager;
  } catch (err) {
    return { ok: false, reason: `@anthropic-ai/sandbox-runtime is not installed (${why(err)})` };
  }

  if (!manager.isSupportedPlatform()) {
    return { ok: false, reason: `sandboxing is not supported on ${process.platform}` };
  }

  try {
    await manager.initialize({
      network: {
        allowedDomains: [...spec.allowedDomains],
        deniedDomains: [...spec.deniedDomains],
      },
      filesystem: {
        // `allowWrite` is very nearly the whole boundary: everything else on
        // the host stays readable but read-only. Making the tree unreadable
        // instead breaks the toolchains the run needs (compilers reading /usr,
        // git reading its own config) for almost no gain.
        //
        // Almost, because "the exfiltration path is egress, not read" — what
        // this comment used to say — is false for one class of file, and
        // `credentials.ts` states why: a secret read into a tool result leaves
        // through OUR request to the model, which no egress rule sees. So
        // `denyRead` is not empty by default; it carries Arterm's own key
        // material, which is the narrowest possible version of the denial this
        // comment is right to reject in general.
        allowWrite: [...spec.writeRoots],
        denyRead: [...spec.denyRead],
        denyWrite: [],
        allowRead: [],
      },
    });
  } catch (err) {
    return { ok: false, reason: `sandbox init failed: ${why(err)}` };
  }

  const deps = await manager.checkDependenciesAsync().catch((err: unknown) => ({
    warnings: [] as string[],
    errors: [why(err)],
  }));
  if (deps.errors.length > 0) {
    await manager.reset().catch(() => {});
    return { ok: false, reason: deps.errors.join("; ") };
  }

  const runner: SandboxRunner = {
    describe: describeSandbox(spec),
    async wrap(command, cwd, signal) {
      // The one input that arrives from outside the boot-time spec. A command
      // asked to run outside the boundary is refused rather than run with the
      // boundary quietly widened to fit it — the Codex/Cursor CVE in one line.
      if (!withinWriteRoots(spec, cwd)) {
        throw new Error(
          `refusing to run: ${cwd} is outside the sandbox boundary (${spec.writeRoots.join(", ")})`,
        );
      }
      return manager.wrapWithSandboxArgv(command, undefined, undefined, signal, cwd);
    },
    release() {
      manager.cleanupAfterCommand();
    },
    async dispose() {
      const entry = established.get(key);
      if (!entry) return;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      established.delete(key);
      // Never throws: teardown runs on the path that ends a SUCCESSFUL run, and
      // a vendor that fails to clean up must not turn finished work into a
      // failure. Leaking the proxies is the cost, and the process is exiting.
      await manager.reset().catch(() => {});
    },
  };
  established.set(key, { runner, holders: 1 });
  return {
    ok: true,
    runner,
    ...(deps.warnings.length > 0 ? { warnings: deps.warnings } : {}),
  };
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
