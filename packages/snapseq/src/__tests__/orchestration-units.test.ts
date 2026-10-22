import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type RunCache, loadCache, lockRun, reusable, saveCache } from "../orchestration/cache.js";
import { describeFilters, matches } from "../orchestration/filters.js";
import { callSite, target } from "../orchestration/run.js";
import type { ResolvedSnapseqConfig } from "../orchestration/types.js";
import { checkRun } from "../orchestration/validate.js";

const dirs: string[] = [];
const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "snapseq-orch-")));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const write = (file: string, text = ""): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const config: ResolvedSnapseqConfig = {
  envs: { dev: { host: "https://dev.example" }, uat: { host: "https://uat.example" } },
  defaultEnv: "dev",
  devices: { desktop: { viewport: { width: 1920, height: 1080 } }, mobile: { viewport: { width: 390, height: 844 } } },
  sequencesDir: "snapseq",
  screenshotsDir: "screenshots",
  numbering: "00",
  format: {},
  stabilize: {},
};

describe("checkRun", () => {
  const dir = tmp();
  for (const f of ["a.seq.ts", "nested/c.seq.ts", "dup.seq.ts", "dup.seq.js"]) write(join(dir, "snapseq", f));
  const check = (sequence: unknown, options: unknown = {}, playwright: unknown[] = [], invocationEnv?: string) =>
    checkRun(sequence, options, playwright, { config, configDir: dir, overrides: [], invocationEnv });

  it("finds a nested id's one file; devices default to the config's, in its order", () => {
    const checked = check("nested/c");
    expect(checked.file).toBe(join(dir, "snapseq/nested/c.seq.ts"));
    expect(checked.deviceOrder).toEqual(["desktop", "mobile"]);
  });

  it("picks named devices in the order given, and takes a map as it is", () => {
    expect(check("a", { devices: ["mobile", "desktop"] }).deviceOrder).toEqual(["mobile", "desktop"]);
    const tablet = { viewport: { width: 1024, height: 1366 } };
    expect(check("a", { devices: { ...config.devices, tablet } }).devices.tablet).toEqual(tablet);
  });

  const date = new Date(0);
  it.each<[string, unknown, unknown, unknown[], string, string?]>([
    ["an unknown sequence", "zzz", {}, [], "no snapseq/zzz.seq.ts; sequences: a, dup, nested/c"],
    ["an id that leaves the folder", "../a", {}, [], 'a sequence id names a file in snapseq/ without .seq.ts, like "12345-spring-launch"; got "../a"'],
    ["two files for one id", "dup", {}, [], "one sequence, 2 files: snapseq/dup.seq.ts, snapseq/dup.seq.js; keep one"],
    ["an unknown option", "a", { device: ["desktop"] }, [], 'unknown option "device"; options take envs, defaultEnv, devices'],
    ["an unknown device", "a", { devices: ["desktop", "tablet"] }, [], 'unknown device "tablet" at options.devices[1]; devices: desktop, mobile'],
    ["a device twice", "a", { devices: ["desktop", "desktop"] }, [], 'device "desktop" twice in options.devices, at [1]'],
    ["no devices", "a", { devices: [] }, [], "options.devices is empty; pick at least one device"],
    ["a device name with a slash", "a", { devices: { "a/b": {} } }, [], 'options.devices["a/b"]: a device name is a folder name, without / or \\'],
    ["an unknown env", "a", { env: "prod" }, [], 'unknown env "prod" at options.env; envs: dev, uat'],
    ["an env the run's own envs drop", "a", { envs: { qa: { host: "https://qa.example" } }, env: "uat" }, [], 'unknown env "uat" at options.env; envs: qa'],
    ["an --env this run does not have", "a", { envs: { qa: { host: "https://qa.example" } } }, [], 'unknown env "uat" from --env or SNAPSEQ_ENV; this run\'s envs: qa', "uat"],
    ["a host that is not a URL", "a", { host: "localhost:3000" }, [], 'options.host must be an http(s) URL, got "localhost:3000"'],
    ["a function", "a", { format: { type: () => "png" } }, [], "options.format.type is a function; options and Playwright overrides reach the child as JSON"],
    ["undefined", "a", { numbering: undefined }, [], "options.numbering is undefined;"],
    ["NaN", "a", {}, [{ timeout: Number.NaN }], "playwright[0].timeout is NaN;"],
    ["a RegExp", "a", {}, [{ grep: /home/ }], "playwright[0].grep is a RegExp;"],
    ["a Date", "a", {}, [{ metadata: { at: date } }], "playwright[0].metadata.at is a Date;"],
    ["a Buffer", "a", {}, [{ use: { clientCertificates: [{ origin: "https://x", cert: Buffer.from("") }] } }], "playwright[0].use.clientCertificates[0].cert is a Buffer;"],
    ["a class instance", "a", { devices: { desktop: new (class Viewport {})() } }, [], "options.devices.desktop is a Viewport;"],
    ["baseURL in a device", "a", { devices: { desktop: { baseURL: "https://x.example" } } }, [], "options.devices.desktop.baseURL is set; the host comes from the env, `host` or --host"],
    ["baseURL in an env's use", "a", { envs: { dev: { host: "https://dev.example", use: { baseURL: "https://x" } } } }, [], "options.envs.dev.use.baseURL is set"],
    ["baseURL in Playwright's use", "a", {}, [{ use: { baseURL: "https://x" } }], "playwright[0].use.baseURL is set"],
    ["baseURL in a Playwright project", "a", {}, [{ projects: [{ name: "x", use: { baseURL: "https://x" } }] }], "playwright[0].projects[0].use.baseURL is set"],
    ["retries", "a", {}, [{ retries: 1 }], "playwright[0].retries is 1; a retry overwrites the shots"],
    ["repeatEach", "a", {}, [{ repeatEach: 2 }], "playwright[0].repeatEach is 2; a sequence runs once per device"],
    ["numbering that is not zeros", "a", { numbering: "01" }, [], 'options.numbering must be zeros, like "00", not "01"'],
  ])("refuses %s", (_, sequence, options, playwright, message, invocationEnv) => {
    expect(() => check(sequence, options, playwright, invocationEnv)).toThrow(message);
  });
});

describe("target", () => {
  it.each([
    ["nothing explicit: the child resolves the default", {}, {}, {}],
    ["the run's env, its host left to the child", { env: "uat" }, {}, { env: "uat" }],
    ["the run's env and host", { env: "uat", host: "https://h.example" }, {}, { env: "uat", host: "https://h.example" }],
    ["--env over the run's env resets the run's host", { env: "uat", host: "https://h.example" }, { env: "dev" }, { env: "dev" }],
    ["--host over the run's env", { env: "uat" }, { host: "https://i.example" }, { env: "uat", host: "https://i.example" }],
    ["--env and --host together", { host: "https://h.example" }, { env: "dev", host: "https://i.example" }, { env: "dev", host: "https://i.example" }],
  ])("%s", (_, options, invocation, expected) => {
    expect(target(options, invocation)).toEqual(expected);
  });
});

describe("filters", () => {
  it("match a substring of the id and an exact device, both when both are given", () => {
    const f = { sequences: ["12346"], devices: ["mobile"] };
    expect(matches(f, "12346-spring-offer", "mobile")).toBe(true);
    expect(matches(f, "12346-spring-offer", "desktop")).toBe(false);
    expect(matches(f, "12345-spring-launch", "mobile")).toBe(false);
    expect(matches({ sequences: [], devices: ["mobile"] }, "anything", "mobile")).toBe(true);
    expect(describeFilters(f)).toBe('"12346" --device mobile');
  });
});

describe("callSite", () => {
  const own = fileURLToPath(new URL("../orchestration/run.ts", import.meta.url));

  it("names the first frame outside snapseq's own files", () => {
    const stack = [
      "Error",
      `    at run (${own}:120:17)`,
      "    at async _default (/app/snapseq/spring.orchestration.ts:9:3)",
      "    at node:internal/process/task_queues:105:5",
    ].join("\n");
    expect(callSite(stack)).toBe("spring.orchestration.ts:9");
  });

  it("reads file URLs, paths with spaces and frames without a function name", () => {
    expect(callSite(`Error\n    at run (${own}:1:1)\n    at file:///My%20App/a.orchestration.mjs:4:2`)).toBe("a.orchestration.mjs:4");
    expect(callSite("Error\n    at main (/My App/b.orchestration.ts:7:1)")).toBe("b.orchestration.ts:7");
    expect(callSite(`Error\n    at run (${own}:1:1)\n    at node:internal/x:1:1`)).toBeUndefined();
  });
});

describe("lockRun", () => {
  it("refuses a live lock, takes over a dead one, and removes only its own", () => {
    const file = join(tmp(), "runs", "r1.json");
    const lock = join(dirname(file), "r1.lock");
    const release = lockRun(file);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    expect(() => lockRun(file)).toThrow(`another snapseq (pid ${process.pid}) is writing this run; its lock is ${lock}`);
    release();
    expect(existsSync(lock)).toBe(false);

    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, String(dead));
    const again = lockRun(file);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    writeFileSync(lock, "12345678"); // somebody else's now: not ours to remove
    again();
    expect(existsSync(lock)).toBe(true);
  });
});

describe("run cache", () => {
  it("reuses an entry only from the same origin, with every shot still a file", () => {
    const dir = tmp();
    const shot = join(dir, "screenshots/r1/a/desktop/01.png");
    write(shot, "png");
    const origin = {
      configFile: join(dir, "snapseq.config.ts"),
      sequencesDir: join(dir, "snapseq"),
      sequenceFile: join(dir, "snapseq/a.seq.ts"),
      screenshotsDir: join(dir, "screenshots"),
    };
    const capture = {
      sequence: "a",
      device: "desktop",
      env: "dev",
      host: "https://dev.example",
      dir: dirname(shot),
      shots: [{ index: 1, name: "01.png", path: shot, url: "https://dev.example/", notes: [], deviceScaleFactor: 1, format: { type: "png" as const }, options: {} }],
    };
    const cache: RunCache = { version: 1, entries: { "a/desktop": { ...origin, capture } } };
    const file = join(dir, "runs/r1.json");
    saveCache(file, cache);
    expect(loadCache(file)).toEqual(cache);
    expect(reusable(cache, "a/desktop", origin)).toEqual(capture);
    expect(reusable(cache, "a/mobile", origin)).toBeUndefined();
    for (const key of Object.keys(origin) as (keyof typeof origin)[]) {
      expect(reusable(cache, "a/desktop", { ...origin, [key]: "/elsewhere" })).toBeUndefined();
    }
    rmSync(shot);
    expect(reusable(cache, "a/desktop", origin)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ version: 2, entries: cache.entries }));
    expect(loadCache(file)).toEqual({ version: 1, entries: {} });
    expect(loadCache(join(dir, "missing.json"))).toEqual({ version: 1, entries: {} });
  });
});
