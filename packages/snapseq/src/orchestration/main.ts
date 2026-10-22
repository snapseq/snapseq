// `snapseq <file>.orchestration.ts …`: parses its own flags, loads the config and the file, runs the function
// with run(), and turns how it ended into the last lines and an exit code: 0; 1 for a script error, a missing
// `await` or no filter match; 130 for Ctrl-C.
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { loadCache, lockRun, runCacheFile } from "./cache.js";
import { type Filters, describeFilters, filtering } from "./filters.js";
import { loadConfig, loadOrchestration } from "./load.js";
import { type Target, createRunner } from "./run.js";
import { trap } from "./stop.js";
import { type Out, failed, footer, heading, hint, interrupted, openRun } from "./terminal.js";
import { isDirName, isHttpUrl, runStamp, sequenceIds } from "./validate.js";

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
  stdout?: Out;
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

export function checkRunName(name: string): string {
  if (!isDirName(name)) throw new Error(`snapseq: --run must be a directory name, not a path: "${name}"`);
  return name;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseArgs(argv: readonly string[]): Args {
  let file: string | undefined;
  const args: Omit<Args, "file" | "filters"> = { pass: [] };
  const sequences: string[] = [];
  const devices: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      if (!ORCHESTRATION_FILE.test(arg)) sequences.push(arg);
      else if (file === undefined) file = arg;
      else throw new Error(`snapseq: one orchestration file at a time, got ${file} and ${arg}`);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string => {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`snapseq: ${flag} requires a value`);
      return next;
    };
    if (Object.hasOwn(REFUSED, flag)) throw new Error(`snapseq: ${flag} does not work with an orchestration file: ${REFUSED[flag]}`);
    switch (flag) {
      case "--env":
        args.env = value();
        break;
      case "--host":
        args.host = value();
        break;
      case "--run":
        args.run = checkRunName(value());
        break;
      case "--device":
        devices.push(value());
        break;
      case "-c":
      case "--config":
        args.config = value();
        break;
      case "--record":
        // Not a Playwright flag: SNAPSEQ_RECORD in each child, as a plain run sets it.
        args.record = eq === -1 ? "1" : arg.slice(eq + 1);
        if (args.record === "") throw new Error('snapseq: --record must be 1 or 0, got ""');
        break;
      default:
        if (PASS_BARE.has(arg)) args.pass.push(arg);
        else if (PASS_VALUE.has(flag)) args.pass.push(flag, value());
        else {
          throw new Error(
            `snapseq: ${flag} does not work with an orchestration file; each child takes --headed, --debug, --trace, --timeout, --max-failures and --record`,
          );
        }
    }
  }
  if (file === undefined) throw new Error("snapseq: no *.orchestration.ts file given");
  return { ...args, file, filters: { sequences, devices } };
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
  delete process.env.SNAPSEQ_OVERRIDES_FILE;
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
      overrides: inputs.overrides ?? [],
      defaultEnv: inputs.defaultEnv,
      configFile,
      run,
      invocation,
      record: args.record,
      filters: args.filters,
      cacheFile,
      cache: loadCache(cacheFile),
      command,
      sequenceIds: sequenceIds(resolve(configDir, config.sequencesDir)),
      out,
    });
    heading(out, args.file, run);
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
      interrupted(out, runDir);
      return code;
    }
    if (message === undefined) out.write("\n");
    else failed(out, message);
    footer(out, runner.state.tally, runner.state.shots, now() - start, runDir);
    if (code === 0 && !filtering(args.filters)) hint(out, args.file, args.config, run);
    openRun(out, dir);
    return code;
  } finally {
    untrap();
    release();
  }
}
