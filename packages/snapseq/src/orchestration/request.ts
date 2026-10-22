// The child side of an orchestration run: the parent writes one request file per `run()` and names it in
// SNAPSEQ_OVERRIDES_FILE; `defineConfig` applies it. The format is the parent's and this file's contract.
import { defineConfig as definePlaywrightConfig, type PlaywrightTestConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceConfig, SnapseqConfig } from "../define.js";

/** What the parent asks of one child. */
export interface Request {
  version: 1;
  /** The id the file runs as, e.g. `nested/pricing`. */
  sequence: string;
  /** Absolute path of the sequence file. */
  file: string;
  /** The run's snapseq options: each key replaces the config's. `devices` holds the devices this child shoots: its projects. */
  snapseq: Partial<Omit<SnapseqConfig, "devices">> & { devices?: Record<string, DeviceConfig> };
  /** The project order: exactly the keys of `snapseq.devices`, as key order is not kept for integer-like names. */
  deviceOrder: string[];
  /** The run's Playwright overrides, plain JSON. */
  playwright: PlaywrightTestConfig[];
  /** `labelWidth`: the least width of the row labels, so the children's rows line up. `showEnv`: name the env on each row. */
  terminal: { labelWidth: number; showEnv?: boolean };
}

// Next to the bundle, as define.ts finds reporter.js: dist/orchestration/result-reporter.js.
const RESULT_REPORTER_PATH =
  typeof __dirname === "string"
    ? join(__dirname, "orchestration", "result-reporter.js")
    : fileURLToPath(new URL("./orchestration/result-reporter.js", import.meta.url));

let read: { file: string; request: Request } | undefined;

/** The request named by SNAPSEQ_OVERRIDES_FILE, read once per process; undefined in an ordinary run. */
export function readRequest(): Request | undefined {
  const file = process.env.SNAPSEQ_OVERRIDES_FILE;
  if (!file) return undefined;
  if (read?.file !== file) {
    const request = JSON.parse(readFileSync(file, "utf8")) as Request;
    if (request.version !== 1) {
      throw new Error(`snapseq: ${file} is a version ${request.version} request, not 1: the snapseq running the orchestration and the config's differ`);
    }
    read = { file, request };
  }
  return read.request;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CACHE = join("node_modules", ".cache", "snapseq");

const within = (outer: string, inner: string): boolean => {
  const rest = relative(outer, inner);
  return !rest.startsWith("..") && !isAbsolute(rest);
};
const overlap = (a: string, b: string): boolean => within(a, b) || within(b, a);

// Playwright empties outputDir before a run, so it must neither hold nor sit inside the parent's run cache, its requests
// or the screenshots. Resolved as Playwright resolves it, against the config's folder: the parent writes the request in
// <config folder>/node_modules/.cache/snapseq/requests.
function assertOutputDir(dir: string | undefined, where: string, screenshotsDir: string): void {
  if (dir === undefined) return;
  const requests = dirname(process.env.SNAPSEQ_OVERRIDES_FILE ?? "");
  const configDir = resolve(requests, "..", "..", "..", "..");
  const output = resolve(configDir, dir);
  if ([join(dirname(requests), "runs"), requests].some((folder) => overlap(output, folder))) {
    throw new Error(`snapseq: outputDir "${dir}"${where} would let Playwright empty the orchestration's ${CACHE}/runs or /requests; point it elsewhere`);
  }
  const screenshots = resolve(configDir, screenshotsDir);
  if (overlap(output, screenshots)) {
    throw new Error(`snapseq: outputDir "${dir}"${where} overlaps the screenshots folder ${screenshots}; Playwright empties its outputDir before a run, point it elsewhere`);
  }
}

/**
 * The request over a config already merged with the consumer's overrides: the run's devices go over the configured
 * projects of their names (a run's viewport beats a configured project override, a configured locale stays), the run's
 * Playwright overrides merge next, and last, so nothing above can undo them, the file, the projects (exactly the
 * devices, in `deviceOrder`), one attempt per test, an outputDir clear of the run cache and the screenshots, and the
 * result reporter.
 */
export function applyRequest(config: PlaywrightTestConfig, request: Request, sequencesDir: string, screenshotsDir: string): PlaywrightTestConfig {
  const names = request.deviceOrder;
  const devices = request.snapseq.devices ?? {};
  const keys = Object.keys(devices);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) {
    throw new Error(`snapseq: the request's deviceOrder (${names.join(", ")}) must list exactly its devices (${keys.join(", ")})`);
  }
  // Over the consumer's own project of that name: the run's device wins where they differ, the rest of the project stays.
  const configured = (name: string) => config.projects?.find((p) => p.name === name);
  const merged = definePlaywrightConfig(
    { ...config, projects: names.map((name) => ({ ...configured(name), name, use: { ...configured(name)?.use, ...devices[name] } })) },
    ...request.playwright,
  );
  // At the top level and on every project. testDir stays the sequences folder, so a nested id keeps its folders.
  const isolation = {
    testDir: sequencesDir,
    testMatch: new RegExp(`^${escape(request.file)}$`),
    testIgnore: [],
    grep: undefined,
    grepInvert: undefined,
  };
  const projects = names.map((name) => ({ ...merged.projects?.find((p) => p.name === name), ...isolation, name }));
  for (const at of [merged, ...projects]) {
    const where = at === merged ? "" : ` in project "${(at as { name: string }).name}"`;
    const retries = at.retries ?? 0;
    const repeatEach = at.repeatEach ?? 1;
    if (retries !== 0 || repeatEach !== 1) {
      throw new Error(
        `snapseq: an orchestration run shoots each part once: retries must be 0 and repeatEach 1, got retries ${retries} and repeatEach ${repeatEach}${where}`,
      );
    }
    assertOutputDir(at.outputDir, where, screenshotsDir);
  }
  for (const project of projects) {
    for (const other of [...(project.dependencies ?? []), ...(project.teardown ? [project.teardown] : [])]) {
      if (!names.includes(other)) {
        throw new Error(`snapseq: project "${project.name}" needs project "${other}", which this run does not shoot`);
      }
    }
  }
  const reporter = typeof merged.reporter === "string" ? [[merged.reporter]] : (merged.reporter ?? []);
  return {
    ...merged,
    ...isolation,
    projects,
    reporter: [...reporter, [RESULT_REPORTER_PATH]] as PlaywrightTestConfig["reporter"],
  };
}
