import { defineConfig as definePlaywrightConfig, type PlaywrightTestConfig } from "@playwright/test";
import { join } from "node:path";
import { CACHE_DIR } from "./orchestration/cache.js";
import { applyRequest, distFile, readRequest } from "./orchestration/request.js";
import type { ResolvedSnapseqConfig } from "./orchestration/types.js";
import { assertDirName, isHttpUrl, runStamp } from "./orchestration/validate.js";
import type { ShotFormat } from "./sequence.js";
import { SEQUENCE_FILE } from "./sequence-id.js";
import type { StabilizeOptions } from "./stabilize.js";

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
   * Ignored when the resolved host differs from `host` (`--host`, `SNAPSEQ_HOST`).
   */
  webServer?: string;
  /**
   * Playwright `use` options for this env, merged over snapseq's defaults:
   * a login in `storageState`, a `locale`, `httpCredentials` for the host's origin.
   * Whatever Playwright takes, in its own words; nothing here is auth-specific.
   */
  use?: DeviceConfig;
  /**
   * Requests answered from files instead of this env's backend: a URL glob
   * (Playwright's `page.route` pattern) to a file path relative to the config
   * file, e.g. `{ "**\/api/search": "snapseq/replay/search.json" }`.
   * `--record` fetches each one live and writes its file; every other run
   * fulfills from the file, as JSON, before the sequence starts. A glob without a
   * host also matches third-party requests; `--record` stops the sequence on the
   * second, different request for the same file.
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
  /** Where `*.seq.ts` files live, relative to the config file. Default `snapseq`. */
  sequencesDir?: string;
  /** Where screenshots are written, relative to the config file. Default `screenshots`. Self-gitignored. */
  screenshotsDir?: string;
  /** The shape of a shot number: `"00"` (default) gives `01.png`, `"000"` gives `001.png`. Zeros only. */
  numbering?: string;
  /** Playwright's screenshot `type` (`"png"`, the default, or `"jpeg"`) and `quality` (JPEG only, 0 to 100). */
  format?: ShotFormat;
  /**
   * Holds the page still for each shot and lets `snapPage` grow pages with viewport-height units: on by default,
   * each step with its own switch; `false` turns it off.
   */
  stabilize?: StabilizeOptions | false;
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
  /** Run directory name, e.g. `2026-10-01 at 04.07.16 PM`. */
  run: string;
  /** The shape of a shot number, e.g. `"00"`. */
  numbering: string;
  /** The config's `format`, or `{}`. */
  format: ShotFormat;
  /** The env's `replay` map, if any. */
  replay?: Record<string, string>;
  /** `--record`: fetch the replay requests live and write their files. */
  record: boolean;
  /** The config's `stabilize`: its options, `{}` by default, or false. */
  stabilize: StabilizeOptions | false;
  /** Set in a child of an orchestration run: the sequence it runs, and how its terminal rows line up with the others. */
  orchestration?: { sequence: string; labelWidth: number; showEnv?: boolean };
}

// Built as ESM (dist/reporter.js).
const REPORTER_PATH = distFile("reporter.js");

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
    // --ui hands the run to Playwright's own window.
    !["--list", "--debug", "--ui", "--ui-host", "--ui-port"].some((flag) =>
      argv.some((a) => a === flag || a.startsWith(`${flag}=`)),
    );
  // The terminal view names the server it may be waiting for.
  return interactive ? [[REPORTER_PATH, { server }]] : [["list", { printSteps: true }]];
}

/** The config with every default filled, before any env is resolved: what an orchestration is handed. */
function resolved(config: SnapseqConfig): ResolvedSnapseqConfig {
  const first = Object.keys(config.envs)[0];
  if (first === undefined) throw new Error("snapseq: envs is empty; name at least one env and its host");
  return {
    ...config,
    defaultEnv: config.defaultEnv || (config.envs.dev ? "dev" : first),
    devices: config.devices ?? DEFAULT_DEVICES,
    sequencesDir: config.sequencesDir ?? "snapseq",
    screenshotsDir: config.screenshotsDir ?? "screenshots",
    numbering: config.numbering ?? "00",
    format: config.format ?? {},
    stabilize: config.stabilize ?? {},
  };
}

/**
 * Build a Playwright Test config for screenshot sequences. Extra arguments are
 * overrides, merged the way Playwright's own `defineConfig` merges them.
 * Env vars: `SNAPSEQ_ENV` picks the env, `SNAPSEQ_HOST` overrides its host,
 * `SNAPSEQ_RUN` names the run directory (default: the time the run started),
 * `SNAPSEQ_RECORD` records the env's `replay` responses, `SNAPSEQ_OPEN=0` keeps
 * the run directory from opening in a file manager at the end of an interactive run.
 * `SNAPSEQ_REQUEST_FILE` is the orchestration parent's request for one child (orchestration/request.ts).
 */
export function defineConfig(
  config: SnapseqConfig,
  ...overrides: PlaywrightTestConfig[]
): PlaywrightTestConfig {
  if (Object.hasOwn(config, "plugins")) {
    throw new Error('snapseq: plugins were removed in 0.7; stabilize is the "stabilize" key, label() and pdf() are steps in an orchestration file');
  }
  const request = readRequest();
  // Before anything is derived, each key the run gives replaces the config's; its devices are the projects.
  if (request) config = { ...config, ...request.snapseq };
  const c = resolved(config);
  const envNames = Object.keys(config.envs);
  // Empty means unset, as for SNAPSEQ_RUN: `--env ""` picks the default.
  const envName = process.env.SNAPSEQ_ENV || c.defaultEnv;
  const env = config.envs[envName];
  if (env === undefined) throw new Error(`snapseq: unknown env "${envName}". Available: ${envNames.join(", ")}`);

  const host = process.env.SNAPSEQ_HOST || env.host;
  // A bare "localhost:3000" parses, as the scheme "localhost:"; a baseURL like that
  // fails on the first goto, far from the config.
  if (!isHttpUrl(host)) throw new Error(`snapseq: host must be an http(s) URL, got "${host}"`);
  const url = new URL(host);
  const { screenshotsDir, numbering } = c;
  // Stamped once per run: this file is evaluated again in every worker process,
  // but workers inherit the env of the main process, which set it first.
  const run = (process.env.SNAPSEQ_RUN ||= runStamp());
  assertDirName("SNAPSEQ_RUN", run);
  if (!/^0+$/.test(numbering)) {
    throw new Error(`snapseq: numbering must be zeros, like "00", not "${numbering}"`);
  }
  const devices = request?.devices ?? Object.entries(c.devices);
  for (const [name] of devices) assertDirName("a device name", name);
  // Not "any non-empty value": SNAPSEQ_RECORD=0 or =false reading as on would write files over a replay.
  const recordValue = process.env.SNAPSEQ_RECORD ?? "";
  if (!["", "0", "false", "1", "true"].includes(recordValue)) {
    throw new Error(`snapseq: SNAPSEQ_RECORD must be 1 or 0, got "${recordValue}"`);
  }
  const metadata: SnapseqMetadata = {
    env: envName,
    host,
    screenshotsDir,
    run,
    numbering,
    format: c.format,
    record: recordValue === "1" || recordValue === "true",
    stabilize: c.stabilize,
    ...(env.replay ? { replay: env.replay } : {}),
    ...(request ? { orchestration: { sequence: request.sequence, ...request.rows } } : {}),
  };
  // An overridden host points at a server the user runs; the configured command
  // would come up elsewhere and the readiness wait would hang until timeout.
  const server =
    env.webServer && host === env.host ? { host, command: env.webServer } : undefined;

  const projects = devices.map(([name, use]) => ({ name, use }));
  const merged = definePlaywrightConfig(
    {
    testDir: c.sequencesDir,
    testMatch: SEQUENCE_FILE,
    // Playwright's own artifacts (.last-run.json, traces, error context) stay out
    // of the screenshots dir. Playwright wipes this dir whole before a run, so it
    // is a folder of its own: the orchestration's run cache lives beside it.
    outputDir: join(CACHE_DIR, "playwright"),
    timeout: 10 * 60_000,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    maxFailures: 1,
    reporter: defaultReporter(server),
    ...(server
      ? {
          webServer: {
            command: server.command,
            url: host,
            // The browser contexts ignore certificate errors; the readiness check must too.
            ignoreHTTPSErrors: true,
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
      // sequence timeout. Long enough for a cold dev build, like the server wait.
      navigationTimeout: 120_000,
      // Without an origin Playwright answers any Basic challenge with these,
      // a third-party image's included.
      ...(env.httpCredentials
        ? { httpCredentials: { origin: url.origin, ...env.httpCredentials } }
        : {}),
      ...env.use,
    },
    projects,
    },
    ...overrides,
    // A request's devices again over a consumer override's project of the same name (Playwright lays use over use: the
    // device's viewport wins, the project's locale stays), then the run's own overrides. Only when there is something
    // to merge: a merge turns a single webServer into a list, which Playwright exposes as no webServer at all.
    ...(request && overrides.length > 0 ? [{ projects }] : []),
    ...(request?.playwright ?? []),
  );
  // Last, so nothing the consumer or the run overrides can undo the isolation.
  const result = request ? applyRequest(merged, request, c.sequencesDir, c.screenshotsDir) : merged;
  // After the merge: an override's own `metadata` replaces the whole object, and
  // the fixtures and the reporter read snapseq's from it.
  result.metadata = { ...result.metadata, snapseq: metadata };
  // `protocol`: the request and the report the parent and the children trade; the parent checks it before any child starts.
  (result as Record<symbol, unknown>)[Symbol.for("snapseq.inputs")] = { protocol: 1, config: c };
  return result;
}
