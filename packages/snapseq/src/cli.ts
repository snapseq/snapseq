#!/usr/bin/env node
// Thin front for `playwright test`: translates snapseq's own flags, finds the
// config, then runs the consumer's Playwright CLI in-process so exit codes and
// Ctrl-C stay Playwright's. Everything else passes through untouched.
import { existsSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lockRun, runCacheFile } from "./orchestration/cache.js";
import { ORCHESTRATION_FILE, checkRunName, main } from "./orchestration/main.js";
import { isDirName } from "./orchestration/validate.js";

const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (ext) => `snapseq.config.${ext}`,
);

const USAGE = `snapseq [filter...] [options]
snapseq <file>.orchestration.ts [--run <name> [sequence...] [--device <name>]] [options]

  --env <name>       env from snapseq.config (same as SNAPSEQ_ENV)
  --host <url>       override that env's host (same as SNAPSEQ_HOST)
  --device <name>    only this device; repeatable (Playwright's --project)
  --run <name>       the run's folder in the screenshots dir (same as SNAPSEQ_RUN; default: the time it started)
  --record           fetch the env's replay responses live and save them (same as SNAPSEQ_RECORD=1)
  -c, --config <p>   config file (default: ./snapseq.config.{ts,js,...})

Every other flag goes to \`playwright test\`: --headed, --ui, --debug,
--trace on, --reporter json, --max-failures 0, ...

With an orchestration file, each run() in it shoots one sequence, then its own
steps run. Given --run naming an earlier run, sequence filters and --device
reshoot the matching parts and reuse the rest. Every child takes --headed,
--debug, --trace, --timeout, --max-failures and --record.
`;

/** The given file; for a directory, or none given, the snapseq.config.* in it. A directory without one goes to Playwright as it is. */
function findConfig(given: string | undefined): string {
  if (given !== undefined && !statSync(given, { throwIfNoEntry: false })?.isDirectory()) return given;
  const config = CONFIG_FILES.map((file) => join(given ?? "", file)).find((file) => existsSync(resolve(file)));
  if (!config && given === undefined) {
    throw new Error(`snapseq: no ${CONFIG_FILES[0]} in ${process.cwd()}; pass -c <path>`);
  }
  return config ?? given!;
}

function translateArgs(argv: string[]): { config: string; args: string[]; run?: string } {
  const out: string[] = [];
  let config: string | undefined;
  let run: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
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
        process.env.SNAPSEQ_ENV = value();
        break;
      case "--host":
        process.env.SNAPSEQ_HOST = value();
        break;
      case "--run":
        run = process.env.SNAPSEQ_RUN = checkRunName(value());
        break;
      case "--device":
        out.push("--project", value());
        break;
      case "--record": {
        // Bare, it records; a value is SNAPSEQ_RECORD's (1, true, 0, false), which defineConfig checks. Empty
        // would read as unset there.
        const record = eq === -1 ? "1" : arg.slice(eq + 1);
        if (record === "") throw new Error('snapseq: --record must be 1 or 0, got ""');
        process.env.SNAPSEQ_RECORD = record;
        break;
      }
      case "-c":
      case "--config":
        config = value();
        break;
      default:
        out.push(arg);
    }
  }

  config = findConfig(config);
  return { config, args: ["test", "-c", config, ...out], run };
}

/** The folder a config is relative to: a directory (Playwright takes `-c <dir>`) is the base itself. */
function configBase(config: string): string {
  const path = resolve(config);
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? path : dirname(path);
}

/**
 * The consumer's Playwright, never a second copy: the one beside the config, so
 * `snapseq -c apps/web/snapseq.config.ts` from a monorepo root finds the app's own,
 * else the one from the working directory.
 */
function playwrightCli(config: string): string {
  const base = configBase(config);
  try {
    return createRequire(join(base, "package.json")).resolve("@playwright/test/cli");
  } catch {
    return createRequire(resolve("package.json")).resolve("@playwright/test/cli");
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
} else if (argv.some((arg) => !arg.startsWith("-") && ORCHESTRATION_FILE.test(arg))) {
  try {
    const code = await main(argv, { findConfig, playwrightCli });
    process.stdout.write("", () => process.exit(code));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
} else {
  try {
    const { config, args, run: flag } = translateArgs(argv);
    const cli = playwrightCli(config);
    // --run, else an inherited SNAPSEQ_RUN: the same named run either way.
    const run = flag ?? (process.env.SNAPSEQ_RUN || undefined);
    if (run !== undefined && !isDirName(run)) throw new Error(`snapseq: SNAPSEQ_RUN must be a directory name, not a path: "${run}"`);
    if (run !== undefined) {
      // A hand reshoot into a named run: keep an orchestration off it while Playwright runs, and drop the run's
      // cache first so no entry can outlive the shots it describes.
      // ponytail: drops every entry, not only the parts this run writes; a later repair reshoots more than it must.
      const cache = runCacheFile(configBase(config), run);
      lockRun(cache);
      rmSync(cache, { force: true });
    }
    process.argv = [process.argv[0]!, cli, ...args];
    await import(pathToFileURL(cli).href);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
