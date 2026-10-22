#!/usr/bin/env node
// Thin front for `playwright test`: translates snapseq's own flags, finds the
// config, then runs the consumer's Playwright CLI in-process so exit codes and
// Ctrl-C stay Playwright's. Everything else passes through untouched.
// An *.orchestration.ts argument hands the whole command to orchestration/main.ts instead.
import { existsSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lockRun, runCacheFile } from "./orchestration/cache.js";
import { ORCHESTRATION_FILE, main, messageOf, parseFlags } from "./orchestration/main.js";
import { assertDirName } from "./orchestration/validate.js";

const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (ext) => `snapseq.config.${ext}`,
);

const USAGE = `snapseq [filter...] [options]
snapseq <file>.orchestration.ts [--run <name> [sequence...] [--device <name>]] [options]

  --env <name>       env from snapseq.config (same as SNAPSEQ_ENV); without --host, drops an inherited SNAPSEQ_HOST
  --host <url>       override that env's host (same as SNAPSEQ_HOST)
  --device <name>    only this device; repeatable (Playwright's --project)
  --run <name>       the run's folder in the screenshots dir (same as SNAPSEQ_RUN; default: the time it started)
  --record           fetch the env's replay responses live and save them (same as SNAPSEQ_RECORD=1)
  -c, --config <p>   config file or its folder (default: ./snapseq.config.{ts,js,...})

Every other flag goes to \`playwright test\`: --headed, --ui, --debug,
--trace on, --reporter json, --max-failures 0, ...
Everything after -- goes to Playwright as given.

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

function translateArgs(argv: string[]): { config: string; args: string[] } {
  const flags = parseFlags(argv);
  if (flags.env !== undefined) process.env.SNAPSEQ_ENV = flags.env;
  if (flags.host !== undefined) process.env.SNAPSEQ_HOST = flags.host;
  if (flags.run !== undefined) process.env.SNAPSEQ_RUN = flags.run;
  if (flags.record !== undefined) process.env.SNAPSEQ_RECORD = flags.record;
  // --env without --host means that env's own host, not one inherited from SNAPSEQ_HOST, as for an orchestration.
  if (flags.env !== undefined && flags.host === undefined) delete process.env.SNAPSEQ_HOST;
  const config = findConfig(flags.config);
  // Before a `--`: Playwright reads what follows one as file filters.
  const end = flags.rest.indexOf("--");
  const at = end === -1 ? flags.rest.length : end;
  const projects = flags.devices.flatMap((d) => ["--project", d]);
  return { config, args: ["test", "-c", config, ...flags.rest.slice(0, at), ...projects, ...flags.rest.slice(at)] };
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
    console.error(messageOf(err));
    process.exit(1);
  }
} else {
  try {
    const { config, args } = translateArgs(argv);
    const cli = playwrightCli(config);
    // --run, else an inherited SNAPSEQ_RUN: the same named run either way.
    const run = process.env.SNAPSEQ_RUN || undefined;
    if (run !== undefined) {
      assertDirName("SNAPSEQ_RUN", run);
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
    console.error(messageOf(err));
    process.exit(1);
  }
}
