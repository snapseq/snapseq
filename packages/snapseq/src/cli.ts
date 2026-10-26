#!/usr/bin/env node
// Thin front for `playwright test`: translates snapseq's own flags, finds the
// config, then runs the consumer's Playwright CLI in-process so exit codes and
// Ctrl-C stay Playwright's. Everything else passes through untouched.
// An *.orchestration.ts argument, or -o <name> as the first one, hands the whole command to orchestration/main.ts instead.
import { existsSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lockRun, runCacheFile } from "./orchestration/cache.js";
import { loadConfig, main, messageOf, parseFlags, splitName } from "./orchestration/main.js";
import { assertDirName } from "./orchestration/validate.js";
import { DEFAULT_TITLE, ORCHESTRATION_FILE, fileWord, missHints, selectSequences, sequenceFiles, sequenceId, sequenceIds } from "./sequence-id.js";

const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (ext) => `snapseq.config.${ext}`,
);

const USAGE = `snapseq [filter...] [options]
snapseq <file>.orchestration.ts [--run <name> [sequence...] [--device <name>]] [options]
snapseq -o <name> [--run <name> [sequence...] [--device <name>]] [options]

  [filter...]        a sequence id or a quoted glob over ids: cll/dosing, 'cll/*', 'wm/**' (nested too), '*' (top level)
  --env <name>       env from snapseq.config (same as SNAPSEQ_ENV); without --host, drops an inherited SNAPSEQ_HOST
  --host <url>       override that env's host (same as SNAPSEQ_HOST)
  --device <name>    only this device; repeatable (Playwright's --project)
  --run <name>       the run's folder in the screenshots dir (same as SNAPSEQ_RUN; default: the time it started)
  --record           fetch the env's replay responses live and save them (same as SNAPSEQ_RECORD=1)
  -c, --config <p>   config file or its folder (default: ./snapseq.config.{ts,js,...})
  -o <name>          the orchestration <sequences dir>/<name>.orchestration.ts, as -o cll or -o wm/proof; first argument only (also --orchestration)

Every other flag goes to \`playwright test\`: --headed, --ui, --debug,
--trace on, --reporter json, --max-failures 0, ...
Everything after -- goes to Playwright as given.

With an orchestration (a file, or -o <name>), each run() in it shoots one sequence, then its own
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

// What Playwright 1.59 (commander, `playwright test --help`) reads after each flag: one value, a value only when the next
// token does not start with "-", or every token up to the next flag. A token after any other flag is a filter word.
const FLAG_VALUES = new Map<string, "one" | "optional" | "many">([
  ...[
    "--browser", "-g", "--grep", "--grep-invert", "--global-timeout", "-j", "--workers", "--max-failures", "--output",
    "--repeat-each", "--reporter", "--retries", "--run-agents", "--shard", "--test-list", "--test-list-invert",
    "--timeout", "--trace", "--tsconfig", "--ui-host", "--ui-port", "--update-source-method",
  ].map((flag) => [flag, "one"] as const),
  ...["--debug", "--only-changed", "-u", "--update-snapshots"].map((flag) => [flag, "optional"] as const),
  ["--project", "many"] as const,
]);

/** Where the filter words are in `tokens`: not flags, not the values of flags that take them; `bare` flags take none. */
function wordsAt(tokens: readonly string[], bare: ReadonlySet<string> = new Set()): number[] {
  const at: number[] = [];
  const free = (i: number): boolean => tokens[i] !== undefined && !tokens[i]!.startsWith("-");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      at.push(i);
      continue;
    }
    let kind = bare.has(token) ? undefined : FLAG_VALUES.get(token);
    if (token[1] !== "-") {
      // `-xj 2`, `-j2`: as commander reads a single-dash token, the first letter that takes a value takes the rest of the token, else the next one.
      const letters = [...token.slice(1)];
      const taker = letters.findIndex((letter) => FLAG_VALUES.has(`-${letter}`));
      if (taker !== -1 && taker < letters.length - 1) continue;
      kind = taker === -1 ? undefined : FLAG_VALUES.get(`-${letters[taker]}`);
    }
    if (kind === "one") i++;
    else if (kind === "optional" && free(i + 1)) i++;
    else if (kind === "many") while (free(i + 1)) i++;
  }
  return at;
}

/** Line terminators as the escapes a regex reads: Playwright takes a `/…/` for a literal only when `.` spans all of it. */
const LINE_BREAKS: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\u2028": "\\u2028", "\u2029": "\\u2029" };

/** Playwright's filter as a regex literal that matches this path and no other: `/…/` without flags is case-sensitive. */
const exactly = (path: string): string => `/^${path.replace(/[.*+?^${}()|[\]\\/]|[\n\r\u2028\u2029]/g, (c) => LINE_BREAKS[c] ?? `\\${c}`)}$/`;

/**
 * `tokens` with the filter words replaced by one regex literal per sequence file they select. A word that selects
 * nothing stops the run. Without words, or where there is no snapseq config to list the sequences (a folder without
 * one goes to Playwright as it is), the tokens are Playwright's as they came.
 */
async function selectFiles(config: string, tokens: string[]): Promise<string[]> {
  const words = wordsAt(tokens);
  const file = resolve(config);
  if (words.length === 0 || !statSync(file, { throwIfNoEntry: false })?.isFile()) return tokens;
  // With the env and host as asked: Playwright loads this config next, in this process, and a .cjs or .mjs one is only
  // evaluated once (jiti imports those natively, so Node caches them), so the evaluation it reuses is the one it would make.
  const dir = resolve(dirname(file), (await loadConfig(file, false)).inputs.config.sequencesDir);
  const ids = sequenceIds(dir);
  // A word that names a sequence file selects its id as it is, whatever glob its name spells.
  const exact: string[] = [];
  const globs: string[] = [];
  // A file word's miss is its id; the message names the word as typed.
  const typed = new Map<string, string>();
  for (const i of words) {
    const path = fileWord(tokens[i]!, dir);
    if (path === undefined) globs.push(tokens[i]!);
    else {
      const id = sequenceId(dir, path, [DEFAULT_TITLE]);
      exact.push(id);
      typed.set(id, tokens[i]!);
    }
  }
  const { ids: selected, misses } = selectSequences(ids, globs, exact);
  if (misses.length > 0) {
    throw new Error(
      misses
        .flatMap((miss) => [
          `snapseq: no sequence matches ${JSON.stringify(typed.get(miss) ?? miss)}`,
          ...missHints(dir, ids, miss).map((line) => `  ${line}`),
        ])
        .join("\n"),
    );
  }
  // The paths as Playwright walks them from the config's own spelling, symlinks included: it filters before it resolves any.
  const files = sequenceFiles(dir, selected).map(exactly);
  const args = tokens.filter((_, i) => !words.includes(i));
  args.splice(words[0]!, 0, ...files);
  return args;
}

async function translateArgs(argv: string[]): Promise<{ config: string; args: string[] }> {
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
  const before = await selectFiles(config, flags.rest.slice(0, at));
  return { config, args: ["test", "-c", config, ...before, ...projects, ...flags.rest.slice(at)] };
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

/**
 * Whether `argv` starts an orchestration: `-o` first, or an orchestration file among the words before a `--`. Not a
 * value: snapseq's own flags have taken theirs (`--run x.orchestration.ts`), and Playwright's take theirs as in a plain
 * run (`-g`, `--project`), except `--debug`, which an orchestration reads bare.
 */
function orchestrating(argv: readonly string[]): boolean {
  if (splitName(argv).name !== undefined) return true;
  const { rest } = parseFlags(argv);
  const end = rest.indexOf("--");
  const tokens = end === -1 ? rest : rest.slice(0, end);
  return wordsAt(tokens, new Set(["--debug"])).some((i) => ORCHESTRATION_FILE.test(tokens[i]!));
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
} else if (orchestrating(argv)) {
  try {
    const code = await main(argv, { findConfig, playwrightCli });
    process.stdout.write("", () => process.exit(code));
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
} else {
  try {
    const { config, args } = await translateArgs(argv);
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
