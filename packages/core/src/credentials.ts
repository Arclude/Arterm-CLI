/**
 * What a model-authored command inherits from the session's environment.
 *
 * `sandbox.ts` answers where an allowed command may reach — the disk it can
 * write, the hosts it can talk to. This file answers the question standing next
 * to it: what the command is HANDED before it runs. `bash` spawns with the
 * agent process's own environment, and that environment is where the user put
 * the credentials they gave to Arterm — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * and `ARTERM_SECRET`, which unlocks the keystore holding every other one.
 *
 * The leak is one command long. `env` prints them, and the moment it does they
 * are in the transcript: sent to the provider on the next turn, written to the
 * session JSONL on disk, quoted into fleet workers' prompts, and folded into
 * whatever a compaction summarizes. None of that crosses the sandbox — the
 * egress allowlist governs where a command may connect, and this path travels
 * out through our own request to the model. It is also not something the model
 * has to intend: `npm install` runs package scripts with the same inherited
 * environment, so a dependency can read them without the model ever asking.
 *
 * The rule is about NAMES, never values. A variable whose name says it holds a
 * credential is withheld; everything else passes through untouched. Guessing
 * from values ("this looks like a token") would eventually eat a `PATH` entry,
 * and a control that breaks the toolchain gets switched off — the same reason
 * the sandbox allows reads and confines writes rather than the reverse.
 *
 * Scrubbing is the DEFAULT, including for a caller that passes no settings at
 * all: a tool context assembled without this wiring (a sub-agent, a test, a
 * standalone call) must not be the one path that still hands the keys over.
 * Turning it off is `credentials.scrub: false`, said deliberately.
 */

/** Config shape for env hygiene (mirrors `ArtermConfig["credentials"]`). */
export interface CredentialSettings {
  /** Withhold credential-named variables from spawned commands (default true). */
  scrub?: boolean;
  /** Names handed through even though they look like a credential. */
  allow?: string[];
  /** Extra names always withheld, whatever they are called (e.g. `DATABASE_URL`). */
  deny?: string[];
}

/** A child environment plus the names that did not make it into one. */
export interface ScrubbedEnv {
  env: Record<string, string | undefined>;
  /** Names withheld, sorted — names are not secret, and knowing one is the fix. */
  withheld: string[];
}

/**
 * Names that say "I hold a credential".
 *
 * Every alternative is anchored on a `_` boundary or the whole name, which is
 * what keeps the list from eating its neighbours: `TOKENIZERS_PARALLELISM`,
 * `KEYBOARD_LAYOUT` and `SSH_ASKPASS` all survive because the word they start
 * with runs on into another one.
 *
 * Two credential-adjacent names are deliberately absent. `SSH_AUTH_SOCK` is a
 * socket path, not a secret, and withholding it breaks `git push` over SSH in
 * the attended sessions that still do that by hand. `XDG_SESSION_*` are desktop
 * plumbing that a stray `SESSION` alternative would have swept up. Both are the
 * false positives that would have made this feature something people disable.
 */
const CREDENTIAL_NAME =
  /(?:^|_)(?:API_?KEYS?|KEYS?|ACCESS_?KEY(?:_?ID)?|SECRETS?|TOKENS?|PASS(?:WORD|WD|PHRASE)?|CREDENTIALS?|PRIVATE_?KEY|CLIENT_?SECRET|AUTH_?TOKEN|SESSION_?TOKEN|BEARER|COOKIE|SIGNING_?KEY|WEBHOOK_?SECRET)(?:_|$)/i;

/**
 * Set by the launcher when IT defaulted `NODE_ENV`, so the value can be taken
 * back out again on the way to a child. A well-known symbol on `globalThis`
 * rather than an environment variable, because an environment variable is
 * precisely the thing that would leak into the children this protects.
 */
const NODE_ENV_DEFAULTED = Symbol.for("arterm.nodeEnvDefaulted");

/**
 * True when `NODE_ENV=production` is OURS rather than the user's.
 *
 * We set it so React loads its production build (see `cli/src/main.ts`), and a
 * spawned command must not inherit it: npm, yarn and pnpm all skip
 * devDependencies under it, so an agent running `npm install` would produce a
 * subtly wrong tree for a reason nobody could see. A value the user exported
 * themselves is theirs, and passes through untouched — which is the only reason
 * this asks the marker instead of just deleting the variable.
 */
function nodeEnvIsOurs(value: string | undefined): boolean {
  return (
    value === "production" && (globalThis as Record<symbol, unknown>)[NODE_ENV_DEFAULTED] === true
  );
}

/**
 * Build the environment a spawned command actually gets.
 *
 * Pure and total: it never reads `process.env` itself, so a test can state the
 * whole input, and the caller decides what "the base environment" means (for a
 * sandboxed run that is the host environment with the wrapper's own additions
 * already merged on top — the wrapper's proxy variables have to survive).
 */
export function scrubEnv(
  base: Record<string, string | undefined>,
  settings?: CredentialSettings,
): ScrubbedEnv {
  if (settings?.scrub === false) {
    // Even here: `scrub: false` is a decision about CREDENTIALS, and this
    // variable is not one — it is a value we invented for our own renderer.
    const env = { ...base };
    // `undefined`, not `delete`: this map's type already carries undefined, and
    // Node skips undefined entries when it builds a child's environment — so
    // the two are the same thing to a spawn, and this one is the house style.
    if (nodeEnvIsOurs(env.NODE_ENV)) env.NODE_ENV = undefined;
    return { env, withheld: [] };
  }

  // Env var names are case-sensitive on POSIX and case-insensitive on Windows.
  // Matching the lists case-insensitively is the behaviour that is correct on
  // one platform and merely generous on the other; the reverse would silently
  // fail to withhold `Api_Key` on the platform where that is the same variable.
  const allow = new Set((settings?.allow ?? []).map(upper));
  const deny = new Set((settings?.deny ?? []).map(upper));

  const env: Record<string, string | undefined> = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(base)) {
    if (withholds(name, allow, deny)) withheld.push(name);
    else env[name] = value;
  }
  // Removed, never REPORTED: `withheld` is what `withheldNote` shows the model
  // when a command fails for want of a credential, and this is not one. A
  // command that fails has nothing to learn from "NODE_ENV was withheld".
  if (nodeEnvIsOurs(env.NODE_ENV)) env.NODE_ENV = undefined;
  return { env, withheld: withheld.sort() };
}

function withholds(name: string, allow: Set<string>, deny: Set<string>): boolean {
  const key = upper(name);
  // An explicit `deny` outranks an explicit `allow`: the two lists overlapping
  // is a config mistake, and the safe reading of a mistake is the closed one.
  if (deny.has(key)) return true;
  if (allow.has(key)) return false;
  return CREDENTIAL_NAME.test(name);
}

/**
 * The line a failed command gets told about what it did not receive.
 *
 * Without it a missing `GITHUB_TOKEN` reads as an unexplained `gh` failure, and
 * an agent that cannot see why a command failed runs it again — the loop
 * detector then spends three iterations discovering what one sentence could
 * have said.
 *
 * `evidence` is what keeps that from becoming noise, and it is the reason this
 * takes an argument at all. Almost every session has an API key in its
 * environment, so an unconditional note would append itself to EVERY failing
 * command — a line about credentials under each failing test run, pointing the
 * model at the wrong cause of a failure that had nothing to do with them. So a
 * name is reported only when the command text or its output actually names it,
 * which is the case the note was written for: tools that need a variable say
 * which one ("set GITHUB_TOKEN"), and a command that reads one spells it out.
 *
 * Names only, capped. A name is the actionable half and is not itself a secret;
 * the value is the thing that must never be echoed back into the transcript.
 */
export function withheldNote(
  withheld: readonly string[],
  evidence: string,
  limit = 6,
): string | undefined {
  const relevant = withheld.filter((name) => evidence.includes(name));
  if (relevant.length === 0) return undefined;
  const shown = relevant.slice(0, limit).join(", ");
  const rest = relevant.length > limit ? `, +${relevant.length - limit} more` : "";
  const hint =
    "Arterm holds back credential-named variables so they cannot reach the transcript; " +
    "list the ones this command needs under `credentials.allow` in the config, " +
    "or pass the value inline.";
  return `[Withheld from this command's environment: ${shown}${rest}. ${hint}]`;
}

function upper(s: string): string {
  return s.toUpperCase();
}

/**
 * Header names that carry a credential but do not look like one by the rule
 * above. `Authorization` is the whole reason: `curl -H "Authorization: Bearer …"`
 * is the ordinary way a secret reaches a command line, and no `_`-delimited
 * alternative catches the word on its own.
 */
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|x-api-key|cookie)$/i;

/** The placeholder a redacted value becomes. Distinct enough to be searchable. */
const REDACTED = "«redacted»";

/** True when a flag or variable NAME says the thing beside it is a credential. */
function credentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name.replace(/^-+/, "").replace(/-/g, "_"));
}

/**
 * A command line safe to show and to store.
 *
 * The environment scrub keeps credentials out of what a command INHERITS; this
 * keeps them out of what a command is RECORDED as. A background process's argv
 * is written to the registry, printed by `/ps`, and read back by the model — so
 * `curl -H "Authorization: Bearer …"` would put the secret in exactly the
 * places `scrubEnv` exists to keep it out of.
 *
 * Same rule and same reason: judged by NAME, never by value. A blob that
 * "looks like a token" is as likely to be a commit hash or a base64 fixture,
 * and a redactor that eats those makes the process list unreadable — which is
 * how a control stops being used.
 */
export function redactCommand(argv: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const raw of argv) {
    const arg = raw ?? "";
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }
    // `--token=value` and `API_KEY=value`.
    const assigned = /^([^=\s]+)=([\s\S]*)$/.exec(arg);
    if (assigned?.[1] && credentialName(assigned[1])) {
      out.push(`${assigned[1]}=${REDACTED}`);
      continue;
    }
    // `Authorization: Bearer …`, usually inside a `-H` argument.
    const header = /^([A-Za-z][\w-]*):\s*(\S[\s\S]*)$/.exec(arg);
    if (header?.[1] && (CREDENTIAL_HEADER.test(header[1]) || credentialName(header[1]))) {
      out.push(`${header[1]}: ${REDACTED}`);
      continue;
    }
    // `--token value`: the flag names it, so the NEXT argument is the secret.
    if (arg.startsWith("-") && credentialName(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}
