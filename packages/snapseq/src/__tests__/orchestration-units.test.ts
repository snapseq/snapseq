import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type RunCache, loadCache, lockRun, reusable, saveCache } from "../orchestration/cache.js";
import { describeFilters, matches } from "../orchestration/run.js";
import { parseFlags, splitName } from "../orchestration/main.js";
import { callSite, target } from "../orchestration/run.js";
import { spawnChild } from "../orchestration/spawn.js";
import { partLine } from "../orchestration/run.js";
import type { ResolvedSnapseqConfig } from "../orchestration/types.js";
import { checkRun } from "../orchestration/validate.js";
import { canonical } from "../sequence-id.js";

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
  // node_modules/ is not listed, as Playwright skips it; an unreadable folder is skipped, not the whole listing.
  for (const f of ["a.seq.ts", "nested/c.seq.ts", "dup.seq.ts", "dup.seq.js", "node_modules/x.seq.ts", "locked/y.seq.ts"]) write(join(dir, "snapseq", f));
  chmodSync(join(dir, "snapseq", "locked"), 0o000);
  afterAll(() => chmodSync(join(dir, "snapseq", "locked"), 0o755));
  const check = (sequence: unknown, options: unknown = {}, playwright: unknown[] = [], invocationEnv?: string) =>
    checkRun(sequence, options, playwright, { config, configDir: dir, invocationEnv });

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
    ["two files for one id", "dup", {}, [], "one sequence, 2 files: snapseq/dup.seq.js, snapseq/dup.seq.ts; keep one"],
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
    ["numbering that is not zeros", "a", { numbering: "01" }, [], 'options.numbering must be zeros, like "00", not "01"'],
  ])("refuses %s", (_, sequence, options, playwright, message, invocationEnv) => {
    expect(() => check(sequence, options, playwright, invocationEnv)).toThrow(message);
  });

  it("checks the devices picked from the config for JSON too, naming the path", () => {
    const cert = { viewport: { width: 1, height: 1 }, clientCertificates: [{ origin: "https://x", cert: Buffer.from("c") }] };
    const withCert = { ...config, devices: { ...config.devices, desktop: cert } };
    const run = (options: object) => () => checkRun("a", options, [], { config: withCert, configDir: dir });
    const message = "config.devices.desktop.clientCertificates[0].cert is a Buffer; a device reaches the child as JSON";
    expect(run({})).toThrow(message);
    expect(run({ devices: ["desktop"] })).toThrow(message);
    expect(run({ devices: ["mobile"] })).not.toThrow();
  });

  it("refuses a run with no devices at all, before anything measures them", () => {
    expect(() => checkRun("a", {}, [], { config: { ...config, devices: {} }, configDir: dir })).toThrow(
      "the config has no devices; give this run some",
    );
  });

  it("finds a file the disk names decomposed from an id typed composed, and hands back the disk's spelling", () => {
    const nfd = "caf\u0065\u0301";
    write(join(dir, "snapseq", nfd, `${nfd}.seq.ts`));
    expect(check("caf\u00e9/caf\u00e9").file).toBe(join(dir, "snapseq", nfd, `${nfd}.seq.ts`));
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

describe("parseFlags", () => {
  it("reads --record bare as 1, keeps =0, and refuses an empty value", () => {
    expect(parseFlags(["--record"]).record).toBe("1");
    expect(parseFlags(["--record=0"]).record).toBe("0");
    expect(() => parseFlags(["--record="])).toThrow('snapseq: --record must be 1 or 0, got ""');
  });

  it("hands everything from a `--` on to Playwright as given, snapseq's own flags included", () => {
    expect(parseFlags(["--run", "r", "--", "--run", "x"]).rest).toEqual(["--", "--run", "x"]);
  });
});

describe("splitName", () => {
  it.each([
    [["-o", "cll", "--run", "r1"], "cll", ["--run", "r1"]],
    [["--orchestration", "wm/proof"], "wm/proof", []],
    [["--orchestration=cll", "-c", "x"], "cll", ["-c", "x"]],
    [["-o"], "", []],
    [["-o", "--run", "r1"], "", ["--run", "r1"]],
    [["--orchestration="], "", []],
    [["--orchestration"], "", []],
  ])("reads %j as the name %j, first on the line", (argv, name, rest) => {
    expect(splitName(argv)).toEqual({ name, rest });
  });

  it("leaves a -o anywhere else, and every argument that is not one, as it was", () => {
    for (const argv of [[], ["cll"], ["--grep", "-o", "--list"], ["--", "-o", "cll"], ["x.orchestration.ts", "-o", "cll"], ["-oc"], ["--orchestrations"]]) {
      expect(splitName(argv)).toEqual({ rest: argv });
    }
  });
});

describe("sequenceId", () => {
  it("joins with / on Windows too, so the id matches the one the parent asked for", async () => {
    const path = await import("node:path");
    vi.doMock("node:path", () => ({ ...path.win32, default: path.win32 }));
    vi.doMock("node:fs", async () => ({ ...(await vi.importActual<object>("node:fs")), realpathSync: (p: string) => p }));
    vi.resetModules();
    try {
      const { sequenceId } = await import("../sequence-id.js");
      const id = (titles: string[]) => sequenceId("C:\\app\\snapseq", "C:\\app\\snapseq\\campaign\\pricing.seq.ts", titles);
      expect(id(["sequence"])).toBe("campaign/pricing");
      expect(id(["hero", "sequence"])).toBe("campaign/pricing/hero/sequence");
    } finally {
      vi.doUnmock("node:path");
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
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
    expect(callSite("Error\n    at main (/My (App)/c.orchestration.ts:8:1)")).toBe("c.orchestration.ts:8");
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
    expect(readdirSync(dirname(file))).toEqual(["r1.lock"]); // the takeover left nothing behind
  });

  it("counts a lock that is empty or not a pid as busy: another process may be writing it", () => {
    const file = join(tmp(), "runs", "r1.json");
    const lock = join(dirname(file), "r1.lock");
    for (const text of ["", "abc"]) {
      write(lock, text);
      expect(() => lockRun(file)).toThrow(`snapseq: another snapseq is writing this run; its lock is ${lock}`);
      expect(readFileSync(lock, "utf8")).toBe(text);
    }
  });
});

describe("spawnChild", () => {
  it("keeps why a child could not start", async () => {
    const closed = await spawnChild([join(tmp(), "no-such-node")], {}).closed;
    expect(closed).toMatchObject({ code: null, error: expect.stringContaining("ENOENT") });
  });
});

describe("partLine", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("gives the parent's lines the mark slot a child's rows have: one column where marks are drawn, four for words", () => {
    vi.stubEnv("TERM", "xterm-256color");
    let out = "";
    partLine({ isTTY: true, write: (s: string) => (out += s) }, "=", "a / desktop", 14, "reused  2 shots");
    partLine({ write: (s: string) => (out += s) }, "+", "a / desktop", 14, "building, no capture yet");
    expect(out).toBe("  = a / desktop     reused  2 shots\n  +    a / desktop     building, no capture yet\n");
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

describe("canonical", () => {
  it("resolves a path that does not exist yet through its deepest existing ancestor, so it reads the same once created", () => {
    const dir = tmp();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    const before = canonical(join(dir, "alias", "screenshots", "run1"));
    expect(before).toBe(join(realpathSync(join(dir, "real")), "screenshots", "run1"));
    mkdirSync(join(dir, "real", "screenshots", "run1"), { recursive: true });
    expect(canonical(join(dir, "alias", "screenshots", "run1"))).toBe(before);
  });
});
