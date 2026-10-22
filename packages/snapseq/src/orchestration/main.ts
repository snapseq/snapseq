// `snapseq <file>.orchestration.ts …`: parses its own flags, loads the config and the file, runs the function
// with run(), and turns how it ended into the last lines and an exit code: 0; 1 for a script error, a missing
// `await` or no filter match; 130 for Ctrl-C.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Jiti } from "jiti";
import { openRun } from "../open.js";
import { ORDER, type OutStream, shotCount } from "../reporter.js";
import { lockRun, runCacheFile } from "./cache.js";
import { type Filters, type Target, createRunner, describeFilters, filtering } from "./run.js";
import type { Orchestration, ResolvedSnapseqConfig } from "./types.js";
import { assertDirName, isHttpUrl, runStamp } from "./validate.js";

export const ORCHESTRATION_FILE = /\.orchestration\.[cm]?[jt]s$/;

const PASS_BARE = new Set(["--headed", "--debug"]);
const PASS_VALUE = new Set(["--trace", "--timeout", "--max-failures"]);
const REFUSED: Record<string, string> = {
  "--ui": "it opens one Playwright window on one run; open a sequence in it without the orchestration file",
  "--list": "the orchestration decides its sequences while it runs",
  "--shard": "an orchestration runs its sequences one after another, in its own order",
  "--repeat-each": "a second pass would overwrite the shots of the first",
  "--retries": "a retry overwrites the shots; catch the rejection of run() and call it again",
  "--reporter": "snapseq reads each child's result through its own reporter",
  "--last-failed": "the orchestration picks its sequences; reshoot a part with --run and a filter",
  "--only-changed": "the orchestration picks its sequences; reshoot a part with --run and a filter",
};

/** What the CLI hands in, and what tests replace. */
export interface Options {
  /** The config: the given path, else the snapseq.config.* in the working directory. */
  findConfig(given: string | undefined): string;
  /** The consumer's `@playwright/test/cli` for this config. */
  playwrightCli(config: string): string;
  stdout?: OutStream;
  now?: () => number;
}

interface Args {
  file: string;
  config?: string;
  run?: string;
  env?: string;
  host?: string;
  record?: string;
  filters: Filters;
  pass: string[];
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** snapseq's own flags, a plain run's and an orchestration's alike; everything else, positionals included, in `rest` in order. */
export function parseFlags(argv: readonly string[]): {
  env?: string;
  host?: string;
  run?: string;
  record?: string;
  config?: string;
  devices: string[];
  rest: string[];
} {
  const flags: ReturnType<typeof parseFlags> = { devices: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `--` ends the flags, as for Playwright: the rest is its, as given.
    if (arg === "--") {
      flags.rest.push(...argv.slice(i));
      break;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`snapseq: ${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--env":
        flags.env = value();
        break;
      case "--host":
        flags.host = value();
        break;
      case "--run":
        flags.run = value();
        assertDirName("--run", flags.run);
        break;
      case "--device":
        flags.devices.push(value());
        break;
      case "-c":
      case "--config":
        flags.config = value();
        break;
      case "--record":
        // Bare, it records; a value is SNAPSEQ_RECORD's (1, true, 0, false), which defineConfig checks. Empty
        // would read as unset there.
        flags.record = eq === -1 ? "1" : arg.slice(eq + 1);
        if (flags.record === "") throw new Error('snapseq: --record must be 1 or 0, got ""');
        break;
      default:
        flags.rest.push(arg);
    }
  }
  return flags;
}

function parseArgs(argv: readonly string[]): Args {
  const { rest, devices, ...flags } = parseFlags(argv);
  let file: string | undefined;
  const sequences: string[] = [];
  const pass: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("-")) {
      if (!ORCHESTRATION_FILE.test(arg)) sequences.push(arg);
      else if (file === undefined) file = arg;
      else throw new Error(`snapseq: one orchestration file at a time, got ${file} and ${arg}`);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(REFUSED, flag)) throw new Error(`snapseq: ${flag} does not work with an orchestration file: ${REFUSED[flag]}`);
    if (PASS_BARE.has(arg)) pass.push(arg);
    else if (PASS_VALUE.has(flag)) {
      const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`snapseq: ${flag} requires a value`);
      pass.push(flag, value);
    } else {
      throw new Error(
        `snapseq: ${flag} does not work with an orchestration file; each child takes --headed, --debug, --trace, --timeout, --max-failures and --record`,
      );
    }
  }
  if (file === undefined) throw new Error("snapseq: no *.orchestration.ts file given");
  return { ...flags, file, filters: { sequences, devices }, pass };
}

/** What defineConfig keeps for the parent under Symbol.for("snapseq.inputs"). */
type Inputs = { protocol: number; config: ResolvedSnapseqConfig };

/**
 * The config through jiti, rooted at the config file so the orchestration resolves imports (tsconfig paths
 * too) the way the config does. SNAPSEQ_ENV and SNAPSEQ_HOST are out of the environment while it loads, so it
 * resolves the default env and cannot fail on an env a run brings in later.
 */
async function loadConfig(file: string): Promise<{ jiti: Jiti; inputs: Inputs }> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(file, { tsconfigPaths: true });
  const saved = { SNAPSEQ_ENV: process.env.SNAPSEQ_ENV, SNAPSEQ_HOST: process.env.SNAPSEQ_HOST };
  delete process.env.SNAPSEQ_ENV;
  delete process.env.SNAPSEQ_HOST;
  let result: Record<symbol, unknown> | undefined;
  try {
    result = await jiti.import<Record<symbol, unknown>>(file, { default: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
  const inputs = result?.[Symbol.for("snapseq.inputs")] as Inputs | undefined;
  if (!inputs) {
    throw new Error(`snapseq: ${file} must export default defineConfig(…) from snapseq 0.7 or newer to run an orchestration`);
  }
  // The request and the report pass between this snapseq and the config's copy, which every child loads.
  if (inputs.protocol !== 1) {
    throw new Error(`snapseq: ${file} loads a snapseq other than the one running this orchestration; install one version for the config and the command`);
  }
  return { jiti, inputs };
}

/** `file` absolute: jiti reads a relative `snapseq/spring.orchestration.ts` as a package's subpath. */
async function loadOrchestration(jiti: Jiti, file: string): Promise<Orchestration> {
  if (!existsSync(file)) throw new Error(`snapseq: no orchestration file at ${file}`);
  const fn = await jiti.import(file, { default: true });
  if (typeof fn !== "function") {
    throw new Error(
      `snapseq: ${file} must export default the orchestration: export default defineOrchestration(async ({ run, config, dir }) => { … })`,
    );
  }
  return fn as Orchestration;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Ctrl-C, a kill or a closed terminal, and errors nothing caught go to these instead of Node's default exit; returns the undo. */
function trap(onInterrupt: () => void, onError: (error: unknown) => void): () => void {
  for (const signal of SIGNALS) process.on(signal, onInterrupt);
  process.on("unhandledRejection", onError);
  process.on("uncaughtException", onError);
  return () => {
    for (const signal of SIGNALS) process.off(signal, onInterrupt);
    process.off("unhandledRejection", onError);
    process.off("uncaughtException", onError);
  };
}

// The parent's own lines after the children's rows: the footer, the reshoot hint.

/** `2m 10s`, or `42s` under a minute. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** `6 passed, 1 reused  72 shots  2m 10s  screenshots/review-1`. */
function footer(out: OutStream, tally: Readonly<Record<string, number>>, shots: number, ms: number, runDir: string): void {
  const counts = ORDER.filter((s) => (tally[s] ?? 0) > 0).map((s) => `${tally[s]} ${s}`);
  out.write(`  ${counts.join(", ") || "nothing captured"}  ${shotCount(shots)}  ${duration(ms)}  ${runDir}\n`);
}

const quote = (s: string): string => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** After a full run, once: how to reshoot one part and rebuild the rest from the run's cache. */
function hint(out: OutStream, file: string, config: string | undefined, run: string): void {
  const c = config === undefined ? "" : ` -c ${quote(config)}`;
  out.write(`  reshoot one part: snapseq ${quote(file)}${c} --run ${quote(run)} <sequence> --device <device>\n`);
}

export async function main(argv: readonly string[], options: Options): Promise<number> {
  const out = options.stdout ?? process.stdout;
  const now = options.now ?? Date.now;
  const args = parseArgs(argv);
  if (filtering(args.filters) && args.run === undefined) {
    throw new Error("snapseq: a filter reshoots parts of an earlier run; name that run with --run <name>");
  }
  // --env without --host drops an inherited SNAPSEQ_HOST; empty means unset, as in defineConfig.
  const invocation: Target = {
    env: (args.env ?? process.env.SNAPSEQ_ENV) || undefined,
    host: (args.host ?? (args.env === undefined ? process.env.SNAPSEQ_HOST : undefined)) || undefined,
  };
  if (invocation.host !== undefined && !isHttpUrl(invocation.host)) {
    throw new Error(`snapseq: host must be an http(s) URL, got "${invocation.host}"`);
  }
  const configFile = resolve(options.findConfig(args.config));
  if (statSync(configFile, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`snapseq: no snapseq.config.ts in ${configFile}; pass -c <path>`);
  const configDir = dirname(configFile);
  const command = [process.execPath, options.playwrightCli(configFile), "test", "-c", configFile, ...args.pass];
  // Named before the config loads, so the config and every child agree on it.
  const run = args.run ?? (process.env.SNAPSEQ_RUN || runStamp(new Date(now())));
  process.env.SNAPSEQ_RUN = run;
  // A request meant for some child must not reshape the parent's own view of the config.
  delete process.env.SNAPSEQ_REQUEST_FILE;
  const { jiti, inputs } = await loadConfig(configFile);
  const { config } = inputs;
  const dir = resolve(configDir, config.screenshotsDir, run);
  const runDir = relative(process.cwd(), dir) || ".";
  if (filtering(args.filters) && !existsSync(dir)) {
    throw new Error(`snapseq: no run "${run}" at ${runDir}; a filter reshoots parts of an earlier run`);
  }
  const fn = await loadOrchestration(jiti, resolve(args.file));
  const cacheFile = runCacheFile(configDir, run);
  const release = lockRun(cacheFile);
  // One way to end, whichever comes first: the script settling, Ctrl-C, or an error nothing caught.
  let halt!: (code: number, message?: string) => void;
  const halted = new Promise<{ code: number; message?: string }>((done) => (halt = (code, message) => done({ code, message })));
  const untrap = trap(
    () => halt(130),
    (error) => halt(1, messageOf(error)),
  );
  try {
    const start = now();
    const runner = createRunner({
      config,
      configFile,
      run,
      invocation,
      record: args.record,
      filters: args.filters,
      cacheFile,
      command,
      out,
    });
    out.write(`  snapseq  ${basename(args.file)}  ${run}\n\n`);
    const script = Promise.resolve()
      .then(() => fn({ run: runner.run, config, dir }))
      .then(
        () => ({ error: undefined as string | undefined }),
        (error: unknown) => ({ error: messageOf(error) }),
      );
    const ended = await Promise.race([script, halted.then(() => undefined)]);
    if (ended) {
      // A run() nobody awaited that failed at once surfaces as an unhandled rejection only after this turn; the trap is still on.
      await new Promise<void>((done) => setImmediate(done));
      const pending = runner.state.active;
      if (pending) {
        const site = pending.site ? ` (${pending.site})` : "";
        halt(1, ended.error ?? `run("${pending.sequence}") was not awaited; the orchestration finished first${site}`);
      } else if (ended.error !== undefined) halt(1, ended.error);
      else if (filtering(args.filters) && !runner.state.matched) halt(1, `no part matched ${describeFilters(args.filters)}`);
      else halt(0);
    }
    await runner.stop();
    const { code, message } = await halted;
    if (code === 130) {
      out.write(`\n  interrupted  ${runDir}\n`);
      return code;
    }
    if (message === undefined) out.write("\n");
    else out.write(`\n  failed  ${message}\n`);
    footer(out, runner.state.tally, runner.state.shots, now() - start, runDir);
    if (code === 0 && !filtering(args.filters)) hint(out, args.file, args.config, run);
    openRun(out, dir);
    return code;
  } finally {
    untrap();
    release();
  }
}
