import type { PlaywrightTestConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineConfig } from "../define.js";
import type { Request } from "../orchestration/request.js";

const envs = { dev: { host: "http://localhost:3000" }, uat: { host: "https://uat.example.com" } };
const FILE = "/abs/app/snapseq/campaign/pricing.seq.ts";
const DESKTOP = { viewport: { width: 1000, height: 700 } };

let dir: string;
let count = 0;
// Writes a request where the parent would and points SNAPSEQ_REQUEST_FILE at it.
function request(over: Partial<Request> = {}): void {
  const file = join(dir, "node_modules", ".cache", "snapseq", "requests", `${++count}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const base: Request = {
    sequence: "campaign/pricing",
    file: FILE,
    configDir: dir,
    snapseq: {},
    devices: [["desktop", DESKTOP]],
    playwright: [],
    rows: { labelWidth: 30, showEnv: true },
  };
  writeFileSync(file, JSON.stringify({ ...base, ...over }));
  vi.stubEnv("SNAPSEQ_REQUEST_FILE", file);
}

type Project = NonNullable<PlaywrightTestConfig["projects"]>[number];
const projects = (c: PlaywrightTestConfig): Project[] => c.projects ?? [];
const meta = (c: PlaywrightTestConfig) =>
  (c.metadata as { snapseq: { numbering: string; screenshotsDir: string; stabilize: unknown; orchestration?: unknown } }).snapseq;
const reporters = (c: PlaywrightTestConfig) => (c.reporter as unknown as [string, unknown?][]).map(([name]) => name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapseq-request-"));
  vi.stubEnv("SNAPSEQ_RUN", "run1");
  vi.stubEnv("SNAPSEQ_ENV", "");
  vi.stubEnv("SNAPSEQ_HOST", "");
  vi.stubEnv("SNAPSEQ_RECORD", "");
  vi.stubEnv("SNAPSEQ_REQUEST_FILE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("defineConfig with an orchestration request", () => {
  it("applies the run's snapseq keys before anything is derived, and its devices as the only projects", () => {
    request({ snapseq: { numbering: "000", screenshotsDir: "shots", stabilize: { motion: false } } });
    const c = defineConfig({ envs, devices: { desktop: {}, mobile: {} }, stabilize: false });
    expect(meta(c)).toMatchObject({ numbering: "000", screenshotsDir: "shots", stabilize: { motion: false } });
    expect(projects(c).map((p) => [p.name, p.use])).toEqual([["desktop", DESKTOP]]);
  });

  it("keeps a single webServer an object: Playwright exposes a list as no webServer at all", () => {
    request();
    const served = { dev: { host: "http://localhost:3000", webServer: "pnpm dev" }, uat: envs.uat };
    expect(defineConfig({ envs: served }).webServer).toMatchObject({ command: "pnpm dev", url: "http://localhost:3000" });
  });

  it("pins the file at the top level and on every project, so a consumer project override cannot undo it", () => {
    request();
    const c = defineConfig(
      { envs },
      {
        testDir: "elsewhere",
        grep: /x/,
        projects: [
          { name: "desktop", testDir: "elsewhere", testMatch: /.*/, testIgnore: /pricing/, grep: /y/, grepInvert: /z/ },
        ],
      },
    );
    for (const at of [c, ...projects(c)]) {
      expect(at.testDir).toBe("snapseq"); // the sequences folder: the id keeps campaign/
      expect(at.testIgnore).toEqual([]);
      expect(at.grep).toBeUndefined();
      expect(at.grepInvert).toBeUndefined();
      const match = at.testMatch as RegExp;
      expect(match.test(FILE)).toBe(true);
      expect(match.test(`${FILE}x`)).toBe(false);
      expect(match.test("/abs/app/snapseq/campaign/pricingXseq.ts")).toBe(false); // the dots are escaped
      expect(match.test(`/other${FILE}`)).toBe(false);
    }
  });

  it("puts the run's devices over a configured project of the same name, keeping what they do not set, then merges the run's Playwright overrides", () => {
    request({
      devices: [["desktop", DESKTOP], ["300", { viewport: { width: 300, height: 250 } }]],
      playwright: [{ timeout: 5_000, projects: [{ name: "300", use: { locale: "fr" } }] }],
    });
    const c = defineConfig({ envs }, { projects: [{ name: "desktop", use: { viewport: { width: 1, height: 1 }, locale: "de" } }] });
    expect(projects(c).map((p) => p.name)).toEqual(["desktop", "300"]); // the request's order, where an object would put "300" first
    expect(projects(c)[0]?.use).toEqual({ ...DESKTOP, locale: "de" }); // the run's viewport, the configured locale
    expect(projects(c)[1]?.use).toEqual({ viewport: { width: 300, height: 250 }, locale: "fr" });
    expect(c.timeout).toBe(5_000);
  });

  it("throws on more than one attempt per test after the merge, naming the project", () => {
    request();
    expect(() => defineConfig({ envs }, { retries: 1 })).toThrow("retries must be 0 and repeatEach 1, got retries 1 and repeatEach 1");
    request({ playwright: [{ repeatEach: 2 }] });
    expect(() => defineConfig({ envs })).toThrow("got retries 0 and repeatEach 2");
    request({ playwright: [{ projects: [{ name: "desktop", retries: 2 }] }] });
    expect(() => defineConfig({ envs })).toThrow('got retries 2 and repeatEach 1 in project "desktop"');
  });

  it("throws on an outputDir over the run cache", () => {
    request();
    for (const outputDir of ["node_modules/.cache/snapseq", "node_modules", join(dir, "node_modules/.cache/snapseq/runs/x")]) {
      expect(() => defineConfig({ envs }, { outputDir }), outputDir).toThrow(`outputDir "${outputDir}" would let Playwright empty`);
    }
    expect(() => defineConfig({ envs }, { projects: [{ name: "desktop" }] }, { outputDir: "test-results" })).not.toThrow();
    expect(defineConfig({ envs }).outputDir).toBe("node_modules/.cache/snapseq/playwright");
  });

  it("throws on an outputDir inside the screenshots folder or holding it, naming both", () => {
    request({ snapseq: { screenshotsDir: "shots" } });
    const shots = join(dir, "shots");
    expect(() => defineConfig({ envs }, { outputDir: "shots/run1" })).toThrow(`outputDir "shots/run1" overlaps the screenshots folder ${shots};`);
    request({ snapseq: { screenshotsDir: "shots" }, playwright: [{ projects: [{ name: "desktop", outputDir: shots }] }] });
    expect(() => defineConfig({ envs })).toThrow(`outputDir "${shots}" in project "desktop" overlaps the screenshots folder ${shots};`);
    expect(() => defineConfig({ envs }, { outputDir: "." })).toThrow("would let Playwright empty"); // holds the cache, and the screenshots
    request();
    expect(() => defineConfig({ envs }, { outputDir: "shots/run1" })).not.toThrow(); // the screenshots are in screenshots/ here
  });

  it("appends the result reporter last and tells the fixtures and the terminal what the parent asked", () => {
    request();
    const c = defineConfig({ envs }, { reporter: "dot" });
    expect(reporters(c)[0]).toBe("dot");
    expect(reporters(c).at(-1)).toMatch(/result-reporter\.js$/);
    expect(meta(c).orchestration).toEqual({ sequence: "campaign/pricing", labelWidth: 30, showEnv: true });
    vi.stubEnv("SNAPSEQ_REQUEST_FILE", "");
    const plain = defineConfig({ envs });
    expect(reporters(plain).some((name) => name.endsWith("result-reporter.js"))).toBe(false);
    expect(meta(plain).orchestration).toBeUndefined();
  });
});
