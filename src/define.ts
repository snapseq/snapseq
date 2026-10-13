import { defineConfig as definePlaywrightConfig, type PlaywrightTestConfig } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnvConfig {
  host: string;
  /**
   * HTTP basic auth for this env. Offered to the resolved host's origin only
   * (`--host` counts); set `origin` to send it somewhere else instead, e.g. a
   * host that redirects to a second origin behind the same password.
   */
  httpCredentials?: NonNullable<DeviceConfig["httpCredentials"]>;
  /**
   * Command that serves `host`, e.g. `"pnpm dev --port 3002"`. Started before the
   * run (Playwright `webServer`) unless something already passes Playwright's
   * readiness check at `host`, and stopped afterwards if it was started here.
   * Ignored when the host is overridden (`--host`, `SNAPSEQ_HOST`).
   */
  webServer?: string;
  /**
   * Playwright `use` options for this env, merged over snapseq's defaults:
   * a token in `extraHTTPHeaders`, a login in `storageState`, a `locale`.
   * Whatever Playwright takes, in its own words; nothing here is auth-specific.
   */
  use?: DeviceConfig;
  /**
   * Requests answered from files instead of this env's backend: a URL glob
   * (Playwright's `page.route` pattern) to a file path relative to the config
   * file, e.g. `{ "**\/api/search": "captures/replay/search.json" }`.
   * `--record` fetches each one live and writes its file; every other run
   * fulfills from the file, as JSON, before the capture starts.
   */
  replay?: Record<string, string>;
}

/** Playwright `use` options for one project, e.g. `{ viewport, deviceScaleFactor, hasTouch }` or `devices["iPhone 14"]`. */
export type DeviceConfig = NonNullable<PlaywrightTestConfig["use"]>;

export interface SnapseqConfig {
  envs: Record<string, EnvConfig>;
  /** Env used when `SNAPSEQ_ENV` is unset. Defaults to `"dev"` if present, else the first env. */
  defaultEnv?: string;
  /** One Playwright project per key. Defaults to `desktop` and `mobile`. */
  devices?: Record<string, DeviceConfig>;
  /** Where `*.capture.ts` files live, relative to the config file. Default `captures`. */
  capturesDir?: string;
  /** Where screenshots are written, relative to the config file. Default `.screenshots`. Self-gitignored. */
  screenshotsDir?: string;
  /** The shape of a shot number: `"000"` (default) gives `001.png`, `"0000"` gives `0001.png`. Zeros only. */
  numbering?: string;
}

const DEFAULT_DEVICES: Record<string, DeviceConfig> = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
};

/** What the fixtures read back from `config.metadata.snapseq`. */
export interface SnapseqMetadata {
  env: string;
  host: string;
  screenshotsDir: string;
  /** Run directory name, e.g. `2026-10-01 at 4.07.16 PM`. */
  run: string;
  /** The shape of a shot number, e.g. `"000"`. */
  numbering: string;
  /** The env's `replay` map, if any. */
  replay?: Record<string, string>;
  /** `--record`: fetch the replay requests live and write their files. */
  record: boolean;
}

/** One directory name, since the directory it names is wiped: no separators, not `.` or `..`. */
function assertName(what: string, name: string): void {
  if (name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error(`snapseq: ${what} must be a directory name, not a path: "${name}"`);
  }
}

/** Local time, the way Finder names screenshots: `2026-10-01 at 4.07.16 PM`. */
function runStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} at ${h % 12 || 12}.${p(d.getMinutes())}.${p(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

// Built as ESM (dist/reporter.js). The CJS build of this file sees __dirname;
// the ESM build sees import.meta.url. Not tsup's import.meta shim: it breaks on
// a "#" in the path.
const REPORTER_PATH =
  typeof __dirname === "string"
    ? join(__dirname, "reporter.js")
    : fileURLToPath(new URL("./reporter.js", import.meta.url));

/** The live terminal view for an interactive run; otherwise Playwright's list reporter with the shots as step lines. */
function defaultReporter(
  server: { host: string; command: string } | undefined,
): PlaywrightTestConfig["reporter"] {
  const argv = process.argv;
  const interactive =
    !!process.stdout.isTTY &&
    process.env.TERM !== "dumb" &&
    !process.env.CI &&
    !process.env.PWDEBUG &&
    !argv.includes("--list") &&
    !argv.some((a) => a === "--debug" || a.startsWith("--debug="));
  // The terminal view names the server it may be waiting for.
  return interactive ? [[REPORTER_PATH, { server }]] : [["list", { printSteps: true }]];
}

/**
 * Build a Playwright Test config for screenshot captures. Extra arguments are
 * overrides, merged the way Playwright's own `defineConfig` merges them.
 * Env vars: `SNAPSEQ_ENV` picks the env, `SNAPSEQ_HOST` overrides its host,
 * `SNAPSEQ_RUN` names the run directory (default: the time the run started),
 * `SNAPSEQ_RECORD` records the env's `replay` responses.
 */
export function defineConfig(
  config: SnapseqConfig,
  ...overrides: PlaywrightTestConfig[]
): PlaywrightTestConfig {
  const envNames = Object.keys(config.envs);
  // Empty means unset, as for SNAPSEQ_RUN: `--env ""` picks the default.
  const envName =
    process.env.SNAPSEQ_ENV || config.defaultEnv || (config.envs.dev ? "dev" : envNames[0]);
  const env = envName === undefined ? undefined : config.envs[envName];
  if (envName === undefined || env === undefined) {
    throw new Error(
      `snapseq: unknown env "${envName}". Available: ${envNames.join(", ") || "(none)"}`,
    );
  }

  const host = process.env.SNAPSEQ_HOST || env.host;
  const screenshotsDir = config.screenshotsDir ?? ".screenshots";
  // Stamped once per run: this file is evaluated again in every worker process,
  // but workers inherit the env of the main process, which set it first.
  const run = (process.env.SNAPSEQ_RUN ||= runStamp());
  assertName("SNAPSEQ_RUN", run);
  const numbering = config.numbering ?? "000";
  if (!/^0+$/.test(numbering)) {
    throw new Error(`snapseq: numbering must be zeros, like "000", not "${numbering}"`);
  }
  const devices = config.devices ?? DEFAULT_DEVICES;
  for (const name of Object.keys(devices)) assertName("a device name", name);
  const metadata: SnapseqMetadata = {
    env: envName,
    host,
    screenshotsDir,
    run,
    numbering,
    record: !!process.env.SNAPSEQ_RECORD,
    ...(env.replay ? { replay: env.replay } : {}),
  };
  // An overridden host points at a server the user runs; the configured command
  // would come up elsewhere and the readiness wait would hang until timeout.
  const server =
    env.webServer && host === env.host ? { host, command: env.webServer } : undefined;

  return definePlaywrightConfig(
    {
    testDir: config.capturesDir ?? "captures",
    testMatch: /\.capture\.[cm]?[jt]s$/,
    // Playwright's own artifacts (.last-run.json, traces, error context) stay out
    // of the screenshots dir. Playwright wipes this dir whole before a run.
    outputDir: "node_modules/.cache/snapseq",
    timeout: 10 * 60_000,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    maxFailures: 1,
    reporter: defaultReporter(server),
    metadata: { snapseq: metadata },
    ...(server
      ? {
          webServer: {
            command: server.command,
            url: host,
            reuseExistingServer: true,
            timeout: 120_000,
          },
        }
      : {}),
    use: {
      baseURL: host,
      ignoreHTTPSErrors: true,
      actionTimeout: 30_000,
      // Playwright's own default is no limit, and a page that keeps polling
      // never reaches networkidle: without this a goto could run out the whole
      // capture timeout. Long enough for a cold dev build, like the server wait.
      navigationTimeout: 120_000,
      // Without an origin Playwright answers any Basic challenge with these,
      // a third-party image's included.
      ...(env.httpCredentials
        ? { httpCredentials: { origin: new URL(host).origin, ...env.httpCredentials } }
        : {}),
      ...env.use,
    },
    projects: Object.entries(devices).map(([name, use]) => ({
      name,
      use,
    })),
    },
    ...overrides,
  );
}
