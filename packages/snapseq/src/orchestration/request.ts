// The child side of an orchestration run: the parent writes one request file per `run()` and names it in
// SNAPSEQ_REQUEST_FILE; `defineConfig` applies it. The format is the parent's and this file's contract.
import type { PlaywrightTestConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceConfig, SnapseqConfig } from "../define.js";
import { canonical, within } from "../sequence-id.js";
import { CACHE_DIR, cacheDir } from "./cache.js";

/** What the parent asks of one child. */
export interface Request {
  /** The id the file runs as, e.g. `nested/pricing`. */
  sequence: string;
  /** Absolute path of the sequence file. */
  file: string;
  /** The config's folder, absolute: where Playwright resolves outputDir and the run cache lives. */
  configDir: string;
  /** The run's snapseq options: each key replaces the config's. */
  snapseq: Partial<Omit<SnapseqConfig, "devices">>;
  /** The devices this child shoots, in order: its projects. A list, as an object does not keep the order of integer-like names. */
  devices: [string, DeviceConfig][];
  /** The run's Playwright overrides, plain JSON. */
  playwright: PlaywrightTestConfig[];
  /** `labelWidth`: the least width of the row labels, so the children's rows line up. `showEnv`: name the env on each row. */
  rows: { labelWidth: number; showEnv?: boolean };
}

/**
 * `rel` in dist/, beside the bundle this code is built into. The CJS build sees __dirname; the ESM build sees
 * import.meta.url. Not tsup's import.meta shim: it breaks on a "#" in the path.
 */
export function distFile(rel: string): string {
  return typeof __dirname === "string" ? join(__dirname, rel) : fileURLToPath(new URL(rel, import.meta.url));
}

const RESULT_REPORTER_PATH = distFile("orchestration/result-reporter.js");

/** The request named by SNAPSEQ_REQUEST_FILE; undefined in an ordinary run. */
export function readRequest(): Request | undefined {
  const file = process.env.SNAPSEQ_REQUEST_FILE;
  if (!file) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Request;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** By the paths as given and through symlinks too: Playwright's emptying follows a linked folder to what it points at. */
const overlap = (a: string, b: string): boolean => {
  const [ra, rb] = [canonical(a), canonical(b)];
  return within(a, b) || within(b, a) || within(ra, rb) || within(rb, ra);
};

// Playwright empties outputDir before a run, so it must neither hold nor sit inside the parent's run cache, its requests
// or the screenshots. Resolved as Playwright resolves it, against the config's folder.
function assertOutputDir(dir: string | undefined, where: string, configDir: string, screenshotsDir: string): void {
  if (dir === undefined) return;
  const output = resolve(configDir, dir);
  if (["runs", "requests"].some((folder) => overlap(output, join(cacheDir(configDir), folder)))) {
    throw new Error(`snapseq: outputDir "${dir}"${where} would let Playwright empty the orchestration's ${CACHE_DIR}/runs or /requests; point it elsewhere`);
  }
  const screenshots = resolve(configDir, screenshotsDir);
  if (overlap(output, screenshots)) {
    throw new Error(`snapseq: outputDir "${dir}"${where} overlaps the screenshots folder ${screenshots}; Playwright empties its outputDir before a run, point it elsewhere`);
  }
}

/**
 * Last over a config that already holds the run's devices and Playwright overrides, so nothing there can undo them: the
 * file, the projects (exactly the run's devices, in order), one attempt per test, an outputDir clear of the run cache
 * and the screenshots, and the result reporter.
 */
export function applyRequest(merged: PlaywrightTestConfig, request: Request, sequencesDir: string, screenshotsDir: string): PlaywrightTestConfig {
  // At the top level and on every project. testDir stays the sequences folder, so a nested id keeps its folders.
  const isolation = {
    testDir: sequencesDir,
    testMatch: new RegExp(`^${escape(request.file)}$`),
    testIgnore: [],
    grep: undefined,
    grepInvert: undefined,
  };
  const projects = request.devices.map(([name]) => ({ ...merged.projects?.find((p) => p.name === name), ...isolation, name }));
  for (const at of [merged, ...projects]) {
    const where = at === merged ? "" : ` in project "${(at as { name: string }).name}"`;
    const retries = at.retries ?? 0;
    const repeatEach = at.repeatEach ?? 1;
    if (retries !== 0 || repeatEach !== 1) {
      throw new Error(
        `snapseq: an orchestration run shoots each part once: retries must be 0 and repeatEach 1, got retries ${retries} and repeatEach ${repeatEach}${where}`,
      );
    }
    assertOutputDir(at.outputDir, where, request.configDir, screenshotsDir);
  }
  const reporter = typeof merged.reporter === "string" ? [[merged.reporter]] : (merged.reporter ?? []);
  return {
    ...merged,
    ...isolation,
    projects,
    reporter: [...reporter, [RESULT_REPORTER_PATH]] as PlaywrightTestConfig["reporter"],
  };
}
