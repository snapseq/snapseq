#!/usr/bin/env node
// Thin front for `playwright test`: translates snapseq's own flags, finds the
// config, then runs the consumer's Playwright CLI in-process so exit codes and
// Ctrl-C stay Playwright's. Everything else passes through untouched.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (ext) => `snapseq.config.${ext}`,
);

const USAGE = `snapseq [filter...] [options]

  --env <name>       env from snapseq.config (same as SNAPSEQ_ENV)
  --host <url>       override that env's host (same as SNAPSEQ_HOST)
  --device <name>    only this device; repeatable (Playwright's --project)
  --record           fetch the env's replay responses live and save them (same as SNAPSEQ_RECORD=1)
  -c, --config <p>   config file (default: ./snapseq.config.{ts,js,...})

Every other flag goes to \`playwright test\`: --headed, --ui, --debug,
--trace on, --reporter json, --max-failures 0, ...
`;

function translateArgs(argv: string[]): string[] {
  const out: string[] = [];
  let config: string | undefined;

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
      case "--device":
        out.push("--project", value());
        break;
      case "--record":
        process.env.SNAPSEQ_RECORD = "1";
        break;
      case "-c":
      case "--config":
        config = value();
        break;
      default:
        out.push(arg);
    }
  }

  config ??= CONFIG_FILES.find((file) => existsSync(resolve(file)));
  if (!config) {
    throw new Error(`snapseq: no ${CONFIG_FILES[0]} in ${process.cwd()}; pass -c <path>`);
  }
  return ["test", "-c", config, ...out];
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
} else {
  try {
    const args = translateArgs(argv);
    // The consumer's Playwright, resolved from the working directory, never a second copy.
    const cli = createRequire(resolve("package.json")).resolve("@playwright/test/cli");
    process.argv = [process.argv[0]!, cli, ...args];
    await import(pathToFileURL(cli).href);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
