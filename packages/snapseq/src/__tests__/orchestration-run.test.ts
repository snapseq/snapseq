import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../orchestration/main.js";

// main() in this process, each run()'s child a stand-in for `playwright test` (fixtures/fake-playwright.mjs)
// that does what the project's scenario.json says and logs what it was given to calls.jsonl.
const FAKE = fileURLToPath(new URL("./fixtures/fake-playwright.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const LAUNCH = "12345-spring-launch";
const OFFER = "12346-spring-offer";
const dirs: string[] = [];
let saved: NodeJS.ProcessEnv;
const g = globalThis as { result?: unknown; err?: string; importEnv?: unknown };

beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("SNAPSEQ_") || key === "CI") delete process.env[key];
  delete g.result;
  delete g.err;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// What defineConfig keeps for the parent, written out so each test's config loads without Playwright; one test
// below reads what the real defineConfig keeps.
const CONFIG = `const config = {
  envs: { dev: { host: "https://dev.example" }, uat: { host: "https://uat.example" } },
  defaultEnv: "dev",
  devices: { desktop: { viewport: { width: 1920, height: 1080 } }, mobile: { viewport: { width: 390, height: 844 } } },
  sequencesDir: "snapseq",
  screenshotsDir: "screenshots",
  numbering: "00",
  format: {},
  stabilize: {},
};
(globalThis as any).importEnv = [process.env.SNAPSEQ_ENV, process.env.SNAPSEQ_HOST, process.env.SNAPSEQ_RUN];
export default { [Symbol.for("snapseq.inputs")]: { protocol: 1, config } };
`;

function project(scenario: object = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "snapseq-orch-")));
  dirs.push(dir);
  const files: Record<string, string> = {
    "snapseq.config.ts": CONFIG,
    [`snapseq/${LAUNCH}.seq.ts`]: "",
    [`snapseq/${OFFER}.seq.ts`]: "",
    "snapseq/nested/pricing.seq.ts": "",
    "scenario.json": JSON.stringify(scenario),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

interface Call {
  argv: string[];
  requestFile: string;
  request: Record<string, unknown> & { devices: [string, unknown][]; sequence: string };
  env: Record<string, string | null>;
  cacheAtStart: { entries: Record<string, unknown> } | null;
}

/** The devices a child was asked for, in order. */
const devicesOf = (call: Call): string[] => call.request.devices.map(([device]) => device);

/** main() with `argv`, in this process: its exit code, what it printed and the calls the fake child logged. */
async function invoke(dir: string, argv: string[]) {
  let out = "";
  const code = await main(argv, {
    findConfig: (given) => given ?? join(dir, "snapseq.config.ts"),
    playwrightCli: () => FAKE,
    stdout: { write: (s: string) => (out += s) },
    now: () => 0,
  });
  const log = join(dir, "calls.jsonl");
  const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  rmSync(log, { force: true });
  return { code, out, calls };
}

const write = (file: string, text = ""): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Writes `body` as the function body of snapseq/`name`.orchestration.ts (its first line is line 2) and returns the file. */
function script(dir: string, body: string, name = "spring"): string {
  const file = join(dir, `snapseq/${name}.orchestration.ts`);
  write(file, `export default async ({ run, config, dir }: any) => {\n${body}\n};\n`);
  return file;
}

/** Writes `body` as the orchestration's function body and runs the file. */
async function orchestrate(dir: string, body: string, args: string[] = [], name = "spring") {
  const file = script(dir, body, name);
  return { ...(await invoke(dir, [file, "-c", join(dir, "snapseq.config.ts"), ...args])), file };
}

/** The fake as the project's own `@playwright/test/cli`, where the built bin looks for it. */
function fakePlaywright(dir: string): string {
  const pkg = join(dir, "node_modules/@playwright/test");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", type: "module" }));
  copyFileSync(FAKE, join(pkg, "cli.js"));
  return dir;
}

/** The built bin in its own process, as a terminal runs it. */
function bin(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("SNAPSEQ_") && k !== "CI") env[k] = v;
  const proc = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let out = "";
  proc.stdout.on("data", (d: Buffer) => (out += d));
  proc.stderr.on("data", (d: Buffer) => (out += d));
  // On exit, not close: a child left behind keeps the pipes open.
  const closed = new Promise<{ status: number | null; out: string }>((ok) => proc.on("exit", (status) => ok({ status, out })));
  return { proc, closed };
}

const runDir = (dir: string, run: string): string => relative(process.cwd(), join(dir, "screenshots", run));
const cacheOf = (dir: string, run: string) =>
  JSON.parse(readFileSync(join(dir, "node_modules/.cache/snapseq/runs", `${run}.json`), "utf8")) as {
    entries: Record<string, { configFile: string; sequencesDir: string; sequenceFile: string; screenshotsDir: string; capture: unknown }>;
  };
const summary = (captures: unknown) =>
  (captures as { sequence: string; device: string; reused: boolean }[]).map((c) => `${c.sequence}/${c.device}${c.reused ? " reused" : ""}`);

describe("a full run", () => {
  it("shoots each call in a child, returns one capture per device in order, caches them and says how to reshoot", async () => {
    const dir = project();
    const r = await orchestrate(dir, `(globalThis as any).result = await run("${LAUNCH}");`, ["--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop`, `${LAUNCH}/mobile`]);
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call!.argv).toEqual(["test", "-c", join(dir, "snapseq.config.ts")]);
    expect(call!.request).toEqual({
      sequence: LAUNCH,
      file: join(dir, `snapseq/${LAUNCH}.seq.ts`),
      configDir: dir,
      snapseq: {},
      devices: [
        ["desktop", { viewport: { width: 1920, height: 1080 } }],
        ["mobile", { viewport: { width: 390, height: 844 } }],
      ],
      playwright: [],
      // The widest id in snapseq/ (19), " / ", the widest device (7), the widest env a call could show, " (uat)".
      rows: { labelWidth: 35, showEnv: false },
    });
    expect(dirname(call!.requestFile)).toBe(join(dir, "node_modules/.cache/snapseq/requests"));
    expect(existsSync(call!.requestFile)).toBe(false);
    expect(call!.env).toEqual({ SNAPSEQ_ENV: null, SNAPSEQ_HOST: null, SNAPSEQ_RUN: "r1", SNAPSEQ_OPEN: null, SNAPSEQ_RECORD: null });

    const cache = cacheOf(dir, "r1");
    expect(Object.keys(cache.entries)).toEqual([`${LAUNCH}/desktop`, `${LAUNCH}/mobile`]);
    expect(cache.entries[`${LAUNCH}/desktop`]).toMatchObject({
      configFile: join(dir, "snapseq.config.ts"),
      sequencesDir: join(dir, "snapseq"),
      sequenceFile: join(dir, `snapseq/${LAUNCH}.seq.ts`),
      screenshotsDir: join(dir, "screenshots"),
      capture: { sequence: LAUNCH, device: "desktop", dir: join(dir, `screenshots/r1/${LAUNCH}/desktop`) },
    });
    expect(existsSync(join(dir, "node_modules/.cache/snapseq/runs/r1.lock"))).toBe(false);

    expect(r.out).toContain("  snapseq  spring.orchestration.ts  r1\n");
    expect(r.out).toContain(`  2 passed  4 shots  0s  ${runDir(dir, "r1")}\n`);
    expect(r.out).toContain(`  reshoot one part: snapseq ${r.file} -c ${join(dir, "snapseq.config.ts")} --run r1 <sequence> --device <device>\n`);
  });

  it("sends the run's options with device names resolved and env and host left to the environment", async () => {
    const dir = project();
    const r = await orchestrate(
      dir,
      `await run("${OFFER}", { devices: ["mobile"], numbering: "000", stabilize: { motion: false }, env: "uat", host: "https://h.example" }, { timeout: 60000 });`,
      ["--run", "r1"],
    );
    expect(r.code, r.out).toBe(0);
    const [call] = r.calls;
    expect(call!.request.snapseq).toEqual({ numbering: "000", stabilize: { motion: false } });
    expect(call!.request.devices).toEqual([["mobile", { viewport: { width: 390, height: 844 } }]]);
    expect(call!.request.playwright).toEqual([{ timeout: 60000 }]);
    expect(call!.request.rows).toEqual({ labelWidth: 35, showEnv: true }); // " (uat)" on every row
    expect(call!.env).toMatchObject({ SNAPSEQ_ENV: "uat", SNAPSEQ_HOST: "https://h.example" });
  });

  it("pads every child's rows to one width, the widest env any call could show included", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}"); await run("${OFFER}", { env: "uat" });`, ["--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => c.request.rows)).toEqual([{ labelWidth: 35, showEnv: false }, { labelWidth: 35, showEnv: true }]);
  });

  it("reads the inputs the real defineConfig keeps, defaults filled", async () => {
    const dir = project();
    const define = fileURLToPath(new URL("../define.ts", import.meta.url));
    writeFileSync(
      join(dir, "snapseq.config.ts"),
      `import { defineConfig } from ${JSON.stringify(define)};
export default defineConfig({ envs: { dev: { host: "https://dev.example" } }, devices: { wide: { viewport: { width: 2560, height: 1440 } } } });`,
    );
    const r = await orchestrate(dir, `(globalThis as any).result = { config, dir, captures: await run("${LAUNCH}") };`, ["--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    const { config, dir: runDirectory, captures } = g.result as { config: Record<string, unknown>; dir: string; captures: unknown };
    expect(config).toMatchObject({ defaultEnv: "dev", sequencesDir: "snapseq", screenshotsDir: "screenshots", numbering: "00" });
    expect(runDirectory).toBe(join(dir, "screenshots/r1"));
    expect(summary(captures)).toEqual([`${LAUNCH}/wide`]);
  });

  it("names the run itself when --run is not given, before the config loads", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}", { devices: ["desktop"] });`);
    expect(r.code, r.out).toBe(0);
    const stamp = r.calls[0]!.env.SNAPSEQ_RUN!;
    expect(stamp).toMatch(/^\d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d [AP]M$/);
    expect((g.importEnv as unknown[])[2]).toBe(stamp);
    expect(r.out).toContain(`--run '${stamp}' <sequence>`);
  });
});

describe("env and host", () => {
  const envOf = async (args: string[], inherited: Record<string, string>, options = "{}") => {
    const dir = project();
    Object.assign(process.env, inherited);
    const r = await orchestrate(dir, `await run("${LAUNCH}", ${options});`, ["--run", "r1", ...args]);
    expect(r.code, r.out).toBe(0);
    const { SNAPSEQ_ENV, SNAPSEQ_HOST } = r.calls[0]!.env;
    return { SNAPSEQ_ENV, SNAPSEQ_HOST };
  };

  it("--env wins over the run's env and drops an inherited SNAPSEQ_HOST unless --host comes too", async () => {
    expect(await envOf(["--env", "dev"], {}, `{ env: "uat", host: "https://h.example" }`)).toEqual({ SNAPSEQ_ENV: "dev", SNAPSEQ_HOST: null });
    expect(await envOf(["--env", "uat"], { SNAPSEQ_HOST: "https://inherited.example" })).toEqual({ SNAPSEQ_ENV: "uat", SNAPSEQ_HOST: null });
    expect(await envOf(["--env", "uat", "--host", "https://x.example"], { SNAPSEQ_HOST: "https://inherited.example" })).toEqual({
      SNAPSEQ_ENV: "uat",
      SNAPSEQ_HOST: "https://x.example",
    });
  });

  it("an inherited SNAPSEQ_ENV and SNAPSEQ_HOST stay out of the config import and reach every child", async () => {
    const inherited = { SNAPSEQ_ENV: "uat", SNAPSEQ_HOST: "https://inherited.example" };
    expect(await envOf([], inherited, `{ env: "dev" }`)).toEqual(inherited);
    expect(g.importEnv).toEqual([undefined, undefined, "r1"]);
    expect(process.env.SNAPSEQ_ENV).toBe("uat"); // restored after the import
  });
});

describe("a call that does not resolve", () => {
  const site = "(spring.orchestration.ts:2)";
  it.each<[string, object, string]>([
    [
      "a failed device and the sibling maxFailures stopped",
      { devices: { desktop: { status: "failed" }, mobile: { status: "not run" } }, errors: ["Testing stopped early after 1 maximum allowed failures."] },
      `${LAUNCH} failed on desktop, not run on mobile after desktop failed ${site}`,
    ],
    ["a skip, with its reason", { devices: { mobile: { status: "skipped", skipReason: "desktop only" } } }, `${LAUNCH} was skipped on mobile: "desktop only" ${site}`],
    ["a test that never used seq", { devices: { mobile: { capture: false } } }, `${LAUNCH} never used seq on mobile ${site}`],
    ["two tests in the file", { tests: 2 }, `${LAUNCH} ran 2 tests; one sequence per file ${site}`],
    ["a child that died before reporting", { report: "none", exit: 1 }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    ["a zero exit without a report", { report: "none", exit: 0 }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    ["a report that is not JSON", { report: "garbage" }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    [
      "an error outside any test",
      { devices: { desktop: { status: "not run" }, mobile: { status: "not run" } }, errors: ["Error: Timed out waiting 120000ms from config.webServer.\n  at x"] },
      `${LAUNCH}: Timed out waiting 120000ms from config.webServer. ${site}`,
    ],
    ["a capture outside its device folder", { devices: { mobile: { capture: "wrong-dir" } } }, `${LAUNCH} reported no usable capture on mobile: shots in `],
    ["a shot file that is not there", { devices: { mobile: { capture: "missing-file" } } }, "02.png is not a file"],
    ["a passed test without a capture", { devices: { mobile: { capture: false, error: "Error: no snapseq-capture attachment" } } }, `${LAUNCH} reported no usable capture on mobile: no snapseq-capture attachment ${site}`],
    ["a report and an exit that disagree", { exit: 1 }, `${LAUNCH}: child ended with 1 after reporting passed; see the output above ${site}`],
  ])("rejects %s", async (_, scenario, message) => {
    const dir = project({ [LAUNCH]: scenario });
    const r = await orchestrate(dir, `await run("${LAUNCH}");`, ["--run", "r1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`\n  failed  `);
    expect(r.out).toContain(message);
  });

  it("caches the siblings that passed, so a caught retry reshoots only what failed", async () => {
    const dir = project({ [LAUNCH]: { devices: { mobile: { status: "failed" } } } });
    const r = await orchestrate(
      dir,
      `try { await run("${LAUNCH}"); } catch (e) { (globalThis as any).err = (e as Error).message; }
const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(join(dir, "scenario.json"))}, "{}");
(globalThis as any).result = await run("${LAUNCH}");`,
      ["--run", "r1"],
    );
    expect(r.code, r.out).toBe(0);
    expect(g.err).toBe(`${LAUNCH} failed on mobile (spring.orchestration.ts:2)`);
    expect(r.calls.map(devicesOf)).toEqual([["desktop", "mobile"], ["mobile"]]);
    expect(r.calls[1]!.cacheAtStart!.entries).toHaveProperty([`${LAUNCH}/desktop`]);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop reused`, `${LAUNCH}/mobile`]);
  });

  it("reshoots a sibling that passed when its files are gone by the retry", async () => {
    const dir = project({ [LAUNCH]: { devices: { mobile: { status: "failed" } } } });
    const r = await orchestrate(
      dir,
      `try { await run("${LAUNCH}"); } catch {}
const { rmSync, writeFileSync } = await import("node:fs");
rmSync(${JSON.stringify(join(dir, `screenshots/r1/${LAUNCH}/desktop/01.png`))});
writeFileSync(${JSON.stringify(join(dir, "scenario.json"))}, "{}");
(globalThis as any).result = await run("${LAUNCH}");`,
      ["--run", "r1"],
    );
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map(devicesOf)).toEqual([["desktop", "mobile"], ["desktop", "mobile"]]);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop`, `${LAUNCH}/mobile`]);
  });
});

describe("one orchestration", () => {
  it("runs one call at a time; the second is refused and the first keeps running", async () => {
    const dir = project();
    const r = await orchestrate(
      dir,
      `const first = run("${LAUNCH}");
try { await run("${OFFER}"); } catch (e) { (globalThis as any).err = (e as Error).message; }
(globalThis as any).result = await first;`,
      ["--run", "r1"],
    );
    expect(r.code, r.out).toBe(0);
    expect(g.err).toBe(`run("${OFFER}") while "${LAUNCH}" is running; await it first (spring.orchestration.ts:3)`);
    expect(r.calls.map((c) => c.request.sequence)).toEqual([LAUNCH]);
    expect(summary(g.result)).toHaveLength(2);
  });

  it("refuses a sequence and device it already captured", async () => {
    const dir = project();
    const r = await orchestrate(
      dir,
      `await run("${LAUNCH}", { devices: ["desktop"] });
await run("${LAUNCH}", { devices: ["mobile", "desktop"] });`,
      ["--run", "r1"],
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(`failed  ${LAUNCH}/desktop already captured by this orchestration (spring.orchestration.ts:3)`);
    expect(r.calls).toHaveLength(1);
  });

  it("refuses bad options before any child starts, with the call site", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}", { devices: ["tablet"] });`, ["--run", "r1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`failed  ${LAUNCH}: unknown device "tablet" at options.devices[0]; devices: desktop, mobile (spring.orchestration.ts:2)`);
    expect(r.calls).toHaveLength(0);
  });
});

describe("filters", () => {
  const full = async (dir: string) => {
    const r = await orchestrate(dir, `await run("${LAUNCH}"); await run("${OFFER}");`, ["--run", "r1"]);
    expect(r.code, r.out).toBe(0);
  };
  const repair = (dir: string, filters: string[], name = "repair") =>
    orchestrate(dir, `(globalThis as any).result = [...(await run("${LAUNCH}")), ...(await run("${OFFER}"))];`, ["--run", "r1", ...filters], name);

  it("reshoot the matching parts, reuse the rest from the run's cache, and drop the shot entries before the child starts", async () => {
    const dir = project();
    await full(dir);
    const r = await repair(dir, ["12346*", "--device", "mobile"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([[OFFER, ["mobile"]]]);
    const atStart = Object.keys(r.calls[0]!.cacheAtStart!.entries);
    expect(atStart).toContain(`${OFFER}/desktop`);
    expect(atStart).not.toContain(`${OFFER}/mobile`);
    expect(Object.keys(cacheOf(dir, "r1").entries)).toContain(`${OFFER}/mobile`);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop reused`, `${LAUNCH}/mobile reused`, `${OFFER}/desktop reused`, `${OFFER}/mobile`]);
    // A mark slot as a child's rows have; four columns where the terminal draws words, not marks.
    expect(r.out).toContain(`  =    ${`${LAUNCH} / desktop`.padEnd(35)}  reused  2 shots\n`);
    expect(r.out).toContain(`  1 passed, 3 reused  8 shots  0s  ${runDir(dir, "r1")}\n`);
    expect(r.out).not.toContain("reshoot one part");
  });

  it("build a part with nothing to reuse, say so before it starts, and do not count it as a match", async () => {
    const dir = project();
    await full(dir);
    rmSync(join(dir, `screenshots/r1/${LAUNCH}/desktop/01.png`));
    const r = await repair(dir, ["zzz"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`  +    ${`${LAUNCH} / desktop`.padEnd(35)}  building, no capture yet\n`);
    expect(r.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([[LAUNCH, ["desktop"]]]);
    expect(r.out).toContain('failed  no part matched "zzz"\n    sequences: 12345-spring-launch, 12346-spring-offer, nested/pricing\n');
  });

  it("select by exact id too, and not by a substring: that fails with what it may have meant, after the file ran", async () => {
    const dir = project();
    await full(dir);
    const exact = await repair(dir, [OFFER, "--device", "mobile"]);
    expect(exact.code, exact.out).toBe(0);
    expect(exact.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([[OFFER, ["mobile"]]]);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop reused`, `${LAUNCH}/mobile reused`, `${OFFER}/desktop reused`, `${OFFER}/mobile`]);

    const substring = await repair(dir, ["12346"]);
    expect(substring.code).toBe(1);
    expect(substring.calls).toHaveLength(0); // every part came from the cache
    expect(summary(g.result)).toHaveLength(4); // the file ran to its end, steps included
    expect(substring.out).toContain('failed  no part matched "12346"\n    did you mean 12346-spring-offer?\n');
  });

  it("fail for each word that selected no part, naming it, though another word matched", async () => {
    const dir = project();
    await full(dir);
    const r = await repair(dir, [LAUNCH, "spring-offer", "zzz"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `failed  no part matched "spring-offer"\n    did you mean ${OFFER}?\n  no part matched "zzz"\n    sequences: ${LAUNCH}, ${OFFER}, nested/pricing\n`,
    );
    expect(r.out).not.toContain(`no part matched "${LAUNCH}"`);
    const device = await repair(dir, [LAUNCH, "--device", "mobile"]); // devices keep the one rule: some part matched
    expect(device.code, device.out).toBe(0);
  });

  it("select the part of a sequence file named by its path, in whatever folder the call points at", async () => {
    const dir = project();
    write(join(dir, `alt/${OFFER}.seq.ts`));
    const body = `(globalThis as any).result = await run("${OFFER}", { sequencesDir: "alt" });`;
    const first = await orchestrate(dir, body, ["--run", "r1"], "alt");
    expect(first.code, first.out).toBe(0);
    const r = await orchestrate(dir, body, ["--run", "r1", join(dir, `alt/${OFFER}.seq.ts`), "--device", "mobile"], "alt");
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([[OFFER, ["mobile"]]]);
    // the file of that id in the config's folder is another file
    const other = await orchestrate(dir, body, ["--run", "r1", join(dir, `snapseq/${OFFER}.seq.ts`)], "alt");
    expect(other.code).toBe(1);
    expect(other.calls).toHaveLength(0);
    expect(other.out).toContain(`failed  no part matched "${join(dir, `snapseq/${OFFER}.seq.ts`)}"`);
  });

  it("refuse any other existing file before the orchestration runs, as a plain run does", async () => {
    const dir = project();
    await full(dir);
    write(join(dir, "snapseq/notes.md"));
    write(join(dir, "elsewhere.md"));
    const refused = (file: string) => orchestrate(dir, `(globalThis as any).result = [await run("${LAUNCH}")];`, ["--run", "r1", file]);
    await expect(refused(join(dir, "snapseq/notes.md"))).rejects.toThrow(`snapseq: ${join(dir, "snapseq/notes.md")} is not a sequence file; quote a glob so the shell leaves it: '*'`);
    await expect(refused(join(dir, "elsewhere.md"))).rejects.toThrow(/is not a sequence file; quote a glob so the shell leaves it$/);
    expect(g.result).toBeUndefined();
  });

  it("select the parts of a folder by glob, and hint at a glob for a folder's name", async () => {
    const dir = project();
    const body = `(globalThis as any).result = [...(await run("${LAUNCH}")), ...(await run("nested/pricing"))];`;
    const first = await orchestrate(dir, body, ["--run", "r1"], "glob");
    expect(first.code, first.out).toBe(0);
    const r = await orchestrate(dir, body, ["--run", "r1", "nested/*", "--device", "mobile"], "glob");
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([["nested/pricing", ["mobile"]]]);
    const folder = await orchestrate(dir, body, ["--run", "r1", "nested"], "glob");
    expect(folder.code).toBe(1);
    expect(folder.out).toContain('failed  no part matched "nested"\n    nested is a folder: \'nested/*\' selects its 1 sequence\n');
  });

  it("need --run naming an earlier run, checked before the orchestration loads", async () => {
    const dir = project();
    const file = join(dir, "snapseq/never.orchestration.ts");
    const options = { findConfig: (c: string | undefined) => c!, playwrightCli: () => FAKE, stdout: { write: () => true } };
    await expect(main([file, "12346*"], options)).rejects.toThrow(
      "snapseq: a filter reshoots parts of an earlier run; name that run with --run <name>",
    );
    await expect(main([file, "-c", join(dir, "snapseq.config.ts"), "--run", "nope", "--device", "mobile"], options)).rejects.toThrow(
      `snapseq: no run "nope" at ${runDir(dir, "nope")}; a filter reshoots parts of an earlier run`,
    );
  });
});

describe("ending", () => {
  // Leaves run() pending once its child is up and listening for signals.
  const unawaited = (dir: string) => `run("${LAUNCH}");
const { existsSync } = await import("node:fs");
while (!existsSync(${JSON.stringify(join(dir, "started"))})) await new Promise((ok) => setTimeout(ok, 25));`;

  it("stops a child the script did not await and exits 1 naming the missing await", async () => {
    const dir = project({ [LAUNCH]: { hang: true } });
    const r = await orchestrate(dir, unawaited(dir), ["--run", "r1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`failed  run("${LAUNCH}") was not awaited; the orchestration finished first (spring.orchestration.ts:2)`);
    expect(existsSync(r.calls[0]!.requestFile)).toBe(false);
  });

  it("exits 1 with the error of a run() nobody awaited that failed at once", async () => {
    const dir = project();
    // Vitest fails the file on an unhandled rejection of its own accord; this one is main's to catch.
    const theirs = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    try {
      const r = await orchestrate(dir, `void run("missing");`, ["--run", "r1"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("failed  missing: no snapseq/missing.seq.ts; sequences: ");
      expect(r.calls).toHaveLength(0);
    } finally {
      for (const listener of theirs) process.on("unhandledRejection", listener);
    }
  });

  it("stops the child when the parent is killed, and leaves no lock or request behind", async () => {
    const dir = fakePlaywright(project({ [LAUNCH]: { hang: true } }));
    const file = join(dir, "snapseq/spring.orchestration.ts");
    writeFileSync(file, `export default async ({ run }: any) => { await run("${LAUNCH}"); };\n`);
    const parent = bin(dir, [file, "-c", join(dir, "snapseq.config.ts"), "--run", "r1"]);
    const started = join(dir, "started");
    for (let i = 0; i < 400 && !existsSync(started); i++) await new Promise((ok) => setTimeout(ok, 25));
    const child = Number(readFileSync(started, "utf8"));
    try {
      parent.proc.kill("SIGTERM");
      const { status, out } = await parent.closed;
      expect(status, out).toBe(130);
      expect(() => process.kill(child, 0)).toThrow();
      expect(existsSync(join(dir, "node_modules/.cache/snapseq/runs/r1.lock"))).toBe(false);
      expect(readdirSync(join(dir, "node_modules/.cache/snapseq/requests"))).toEqual([]);
    } finally {
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    }
  });

  it("exits 1 with the message of an error the script threw", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}");\nthrow new Error("label: no shots");`, ["--run", "r1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("\n  failed  label: no shots\n  2 passed  4 shots");
  });

  it("stops the child on Ctrl-C and exits 130 without starting another", async () => {
    const dir = project({ [LAUNCH]: { hang: true } });
    const pending = orchestrate(dir, `await run("${LAUNCH}");\nawait run("${OFFER}");`, ["--run", "r1"]);
    const started = join(dir, "started");
    for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((ok) => setTimeout(ok, 25));
    process.emit("SIGINT");
    const r = await pending;
    expect(r.code).toBe(130);
    expect(r.out).toContain(`\n  interrupted  ${runDir(dir, "r1")}\n`);
    expect(r.out).not.toContain("failed");
    expect(r.calls.map((c) => c.request.sequence)).toEqual([LAUNCH]);
    expect(existsSync(join(dir, "node_modules/.cache/snapseq/runs/r1.lock"))).toBe(false);
  });

  it("insists with SIGTERM when a child ignores SIGINT", async () => {
    const dir = project({ [LAUNCH]: { hang: true, ignoreInt: true } });
    const start = Date.now();
    const r = await orchestrate(dir, unawaited(dir), ["--run", "r1"]);
    expect(r.code).toBe(1);
    expect(Date.now() - start).toBeGreaterThan(9_000); // the SIGINT wait ran out first
    expect(r.out).toContain("was not awaited");
  }, 30_000);
});

describe("arguments", () => {
  it("-c takes the folder of the config, as a plain run does", async () => {
    const dir = fakePlaywright(project());
    const file = join(dir, "snapseq/spring.orchestration.ts");
    writeFileSync(file, `export default async ({ run }: any) => { await run("${LAUNCH}", { devices: ["desktop"] }); };\n`);
    const { status, out } = await bin(dir, [file, "-c", dir, "--run", "r1"]).closed;
    expect(status, out).toBe(0);
    const [call] = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call);
    expect(call!.argv).toEqual(["test", "-c", join(dir, "snapseq.config.ts")]);
  });

  const options = { findConfig: (c: string | undefined) => c!, playwrightCli: () => FAKE, stdout: { write: () => true } };
  it.each([
    ["--ui", "snapseq: --ui does not work with an orchestration file: it opens one Playwright window on one run"],
    ["--reporter=json", "snapseq: --reporter does not work with an orchestration file: snapseq reads each child's result"],
    ["--retries", "snapseq: --retries does not work with an orchestration file: a retry overwrites the shots"],
    ["--workers", "snapseq: --workers does not work with an orchestration file; each child takes --headed, --debug"],
    ["--run=a/b", 'snapseq: --run must be a directory name, not a path: "a/b"'],
  ])("refuses %s", async (flag, message) => {
    await expect(main(["x.orchestration.ts", flag], options)).rejects.toThrow(message);
  });

  it("passes --headed, --debug, --trace, --timeout and --max-failures to every child; --record becomes SNAPSEQ_RECORD", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}", { devices: ["desktop"] });`, [
      "--run",
      "r1",
      "--headed",
      "--trace",
      "on",
      "--timeout=5000",
      "--max-failures",
      "1",
      "--record",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls[0]!.argv).toEqual(["test", "-c", join(dir, "snapseq.config.ts"), "--headed", "--trace", "on", "--timeout", "5000", "--max-failures", "1"]);
    expect(r.calls[0]!.env.SNAPSEQ_RECORD).toBe("1");
  });

  it("refuses a run another live snapseq holds", async () => {
    const dir = project();
    mkdirSync(join(dir, "node_modules/.cache/snapseq/runs"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.cache/snapseq/runs/r1.lock"), String(process.pid));
    await expect(orchestrate(dir, `await run("${LAUNCH}");`, ["--run", "r1"])).rejects.toThrow(
      `another snapseq (pid ${process.pid}) is writing this run`,
    );
  });

  it("refuses a config whose snapseq speaks another protocol, before any child starts", async () => {
    const dir = project();
    writeFileSync(join(dir, "snapseq.config.ts"), CONFIG.replace("protocol: 1", "protocol: 2"));
    await expect(orchestrate(dir, `await run("${LAUNCH}");`, ["--run", "r1"])).rejects.toThrow(
      "loads a snapseq other than the one running this orchestration",
    );
  });
});

// `-o <name>` runs snapseq/<name>.orchestration.ts as if its path had been given.
describe("an orchestration by name", () => {
  const one = `await run("${LAUNCH}", { devices: ["desktop"] });`;
  const cfg = (dir: string): string => join(dir, "snapseq.config.ts");

  it.each([
    ["-o", ["-o", "spring"]],
    ["--orchestration", ["--orchestration", "spring"]],
    ["--orchestration=", ["--orchestration=spring"]],
  ])("runs the one file %s names, as its path would", async (_, lead) => {
    const dir = project();
    const file = script(dir, one);
    const r = await invoke(dir, [...lead, "-c", cfg(dir), "--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.argv).toEqual(["test", "-c", cfg(dir)]);
    expect(r.calls[0]!.request).toMatchObject({ sequence: LAUNCH, devices: [["desktop", expect.anything()]] });
    expect(r.out).toContain("  snapseq  spring.orchestration.ts  r1\n");
    expect(existsSync(file)).toBe(true);
  });

  it("finds a nested name, and the hint names it with -o as its own token, quoted when it needs it", async () => {
    const dir = project();
    script(dir, one, "wm/proof");
    script(dir, one, "my run");
    const nested = await invoke(dir, ["-o", "wm/proof", "-c", cfg(dir), "--run", "r1"]);
    expect(nested.code, nested.out).toBe(0);
    expect(nested.out).toContain("  snapseq  proof.orchestration.ts  r1\n");
    expect(nested.out).toContain(`  reshoot one part: snapseq -o wm/proof -c ${cfg(dir)} --run r1 <sequence> --device <device>\n`);
    const spaced = await invoke(dir, ["-o", "my run", "--run", "r2"]);
    expect(spaced.out).toContain("  reshoot one part: snapseq -o 'my run' --run r2 <sequence> --device <device>\n");
  });

  it("hints a name that starts with - as --orchestration=<name>, which -o could not take", async () => {
    const dir = project();
    script(dir, one, "-draft");
    const r = await invoke(dir, ["--orchestration=-draft", "-c", cfg(dir), "--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`  reshoot one part: snapseq --orchestration=-draft -c ${cfg(dir)} --run r1 <sequence> --device <device>\n`);
  });

  it("repairs a run as after a file: filters and --device reshoot the parts, the cache gives the rest", async () => {
    const dir = project();
    script(dir, `(globalThis as any).result = [...(await run("${LAUNCH}")), ...(await run("${OFFER}"))];`);
    const full = await invoke(dir, ["-o", "spring", "-c", cfg(dir), "--run", "r1"]);
    expect(full.code, full.out).toBe(0);
    const r = await invoke(dir, ["-o", "spring", "-c", cfg(dir), "--run", "r1", "12346*", "--device", "mobile"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [c.request.sequence, devicesOf(c)])).toEqual([[OFFER, ["mobile"]]]);
    expect(summary(g.result)).toEqual([`${LAUNCH}/desktop reused`, `${LAUNCH}/mobile reused`, `${OFFER}/desktop reused`, `${OFFER}/mobile`]);
    expect(r.out).not.toContain("reshoot one part");
  });

  const list = "orchestrations: spring, wm/proof";
  const outside = 'an orchestration name is a path in snapseq/ without .orchestration.ts, like "cll" or "wm/proof"';
  it.each([
    ["an unknown name, listing the names found", ["-o", "zzz"], `snapseq: no snapseq/zzz.orchestration.ts; ${list}`],
    ["-o as the last token", ["-o"], `snapseq: -o needs an orchestration name; ${list}`],
    ["-o before a flag", ["-o", "--run", "r1"], `snapseq: -o needs an orchestration name; ${list}`],
    ["--orchestration with no name", ["--orchestration="], `snapseq: -o needs an orchestration name; ${list}`],
    ["-o before --list, which an orchestration refuses", ["-o", "--list"], `snapseq: -o needs an orchestration name; ${list}`],
    ["-o before a --run with no value", ["-o", "--run"], `snapseq: -o needs an orchestration name; ${list}`],
    ["-o before a filter flag with no --run", ["-o", "--device", "desktop"], `snapseq: -o needs an orchestration name; ${list}`],
    ["a name that leaves the folder", ["-o", "../spring"], `${outside}; got "../spring"`],
    ["an absolute name", ["-o", "/etc/spring"], `${outside}; got "/etc/spring"`],
  ])("refuses %s", async (_, argv, message) => {
    const dir = project();
    script(dir, one);
    script(dir, one, "wm/proof");
    write(join(dir, "snapseq/node_modules/x.orchestration.ts")); // not listed, as for sequences
    await expect(invoke(dir, argv)).rejects.toThrow(message);
    expect(existsSync(join(dir, "calls.jsonl"))).toBe(false);
  });

  it("lists (none) when the folder has no orchestrations, and the ones in the config -c names", async () => {
    const dir = project();
    await expect(invoke(dir, ["-o", "spring"])).rejects.toThrow("snapseq: no snapseq/spring.orchestration.ts; orchestrations: (none)");
    const other = project();
    script(other, one, "other");
    await expect(invoke(dir, ["-o", "-c", cfg(other)])).rejects.toThrow("snapseq: -o needs an orchestration name; orchestrations: other");
    await expect(invoke(dir, ["-o", "--list", `--config=${cfg(other)}`])).rejects.toThrow("snapseq: -o needs an orchestration name; orchestrations: other");
  });

  it("refuses two files for one name, naming both", async () => {
    const dir = project();
    script(dir, one);
    write(join(dir, "snapseq/spring.orchestration.js"));
    await expect(invoke(dir, ["-o", "spring"])).rejects.toThrow(
      "snapseq: one orchestration, 2 files: snapseq/spring.orchestration.js, snapseq/spring.orchestration.ts; keep one",
    );
  });

  it("is one orchestration at a time, and a -o anywhere but first is refused as it was", async () => {
    const dir = project();
    const file = script(dir, one);
    await expect(invoke(dir, ["-o", "spring", "other.orchestration.ts"])).rejects.toThrow(
      "snapseq: one orchestration at a time, got -o spring and other.orchestration.ts",
    );
    await expect(invoke(dir, ["--orchestration=spring", file])).rejects.toThrow("snapseq: one orchestration at a time, got -o spring and");
    await expect(invoke(dir, [file, "-o", "spring"])).rejects.toThrow("snapseq: -o does not work with an orchestration file; each child takes");
  });
});

// The built bin decides between Playwright and an orchestration from the first arguments alone.
describe("the command line", () => {
  /** The project's `@playwright/test/cli` as a stub that logs what it was given, one JSON line per start. */
  function plainPlaywright(dir: string): string {
    const pkg = join(dir, "node_modules/@playwright/test");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@playwright/test", type: "module" }));
    writeFileSync(join(pkg, "cli.js"), `import { appendFileSync } from "node:fs";\nappendFileSync("argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    return dir;
  }
  const given = (dir: string): string[][] =>
    existsSync(join(dir, "argv.jsonl")) ? readFileSync(join(dir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

  it.each([
    ["no arguments", []],
    ["a flag value that looks like a word", ["--grep", "cll", "--retries", "3"]],
    ["words after a `--`", ["--", "cll", "cll/"]],
    ["-o after a `--`", ["--", "-o"]],
    ["-o anywhere but first", ["--grep", "-o", "--list", "--pass-with-no-tests"]],
  ])("sends %s to Playwright as given", async (_, args) => {
    const dir = plainPlaywright(project());
    const { status, out } = await bin(dir, args).closed;
    expect(status, out).toBe(0);
    expect(given(dir)).toEqual([["test", "-c", "snapseq.config.ts", ...args]]);
  });

  describe("with sequence words", () => {
    const IDS = ["bys", "cgvhd/site", "cll/dosing", "cll/efficacy-safety-resources", "cll/home-resonate-2", "ira", "wm/site", "x.y/a+b (1)/c$d"];
    /** A project of these ids and a `cll` orchestration, whose Playwright only logs its argv. */
    function sequences(): string {
      const dir = plainPlaywright(project());
      rmSync(join(dir, "snapseq"), { recursive: true });
      for (const id of IDS) write(join(dir, `snapseq/${id}.seq.ts`));
      write(join(dir, "snapseq/cll.orchestration.ts"));
      return dir;
    }
    /** What Playwright is given for the sequence `id`: a regex literal that takes its file and no other, in any case. */
    const lit = (dir: string, id: string): string => `/^${join(dir, "snapseq", `${id}.seq.ts`).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/`;
    const CLL = IDS.filter((id) => id.startsWith("cll/"));
    const base = ["test", "-c", "snapseq.config.ts"];

    it("stops a word that selects nothing, with what it may have meant, before Playwright starts", async () => {
      const dir = sequences();
      write(join(dir, "cll/dosing.sequence.md")); // a folder in the working directory is no file either
      const folder = await bin(dir, ["cll"]).closed;
      expect(folder.status).toBe(1);
      expect(folder.out).toContain(
        `snapseq: no sequence matches "cll"\n  cll is a folder: 'cll/*' selects its 3 sequences\n  cll is an orchestration: snapseq -o cll\n`,
      );
      const last = await bin(dir, ["ira", "dosing", "zzz"]).closed;
      expect(last.status).toBe(1);
      expect(last.out).toContain(`snapseq: no sequence matches "dosing"\n  did you mean cll/dosing? '**/dosing' selects every dosing\n`);
      expect(last.out).toContain(`snapseq: no sequence matches "zzz"\n  sequences: ${IDS.join(", ")}\n`);
      expect(given(dir)).toEqual([]);
    });

    it("gives Playwright one anchored literal per selected file, none of them a word", async () => {
      const dir = sequences();
      const r = await bin(dir, ["cll/*"]).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(dir)).toEqual([[...base, ...CLL.map((id) => lit(dir, id))]]);
      // Playwright reads /…/ as a regex without flags: it takes its own file and no other, in this case only.
      for (const arg of given(dir)[0]!.slice(3)) {
        const re = new RegExp(/^\/(.*)\/$/.exec(arg)![1]!);
        expect(CLL.map((id) => join(dir, "snapseq", `${id}.seq.ts`)).filter((file) => re.test(file))).toHaveLength(1);
        expect(re.test(arg.toUpperCase())).toBe(false);
      }
    });

    it("escapes every character of a path a regex reads, and the globs in an id select it by its own spelling", async () => {
      const dir = sequences();
      const id = "x.y/a+b (1)/c$d";
      const r = await bin(dir, [id]).closed;
      expect(r.status, r.out).toBe(0);
      const [arg] = given(dir)[0]!.slice(3);
      expect(arg).toBe(lit(dir, id));
      const re = new RegExp(/^\/(.*)\/$/.exec(arg!)![1]!);
      expect(re.test(join(dir, "snapseq", `${id}.seq.ts`))).toBe(true);
      expect(re.test(join(dir, "snapseq", `${id}.seq.tsx`))).toBe(false);
      expect(re.test(join(dir, "snapseq", "x-y/a+b (1)/c$d.seq.ts"))).toBe(false);
    });

    it("puts the literals where the first word was, and keeps --device as --project after them", async () => {
      const dir = sequences();
      const r = await bin(dir, ["-g", "foo", "wm/site", "--headed", "ira", "--device", "mobile"]).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(dir)).toEqual([[...base, "-g", "foo", lit(dir, "ira"), lit(dir, "wm/site"), "--headed", "--project", "mobile"]]);
    });

    it.each<[string, string[], (l: (id: string) => string) => string[]]>([
      ["after a flag that takes a value", ["--retries", "3", "ira"], (l) => ["--retries", "3", l("ira")]],
      ["after a short flag that takes a value", ["-g", "ira", "wm/site"], (l) => ["-g", "ira", l("wm/site")]],
      ["after a flag given its value with =", ["--reporter=json", "ira"], (l) => ["--reporter=json", l("ira")]],
      ["after a flag Playwright does not know", ["--nope", "ira"], (l) => ["--nope", l("ira")]],
      ["after an optional value taken", ["-u", "all", "ira"], (l) => ["-u", "all", l("ira")]],
      ["after an optional value left", ["-u", "--headed", "ira"], (l) => ["-u", "--headed", l("ira")]],
      ["after combined short flags, the last taking its value", ["-xj", "2", "ira"], (l) => ["-xj", "2", l("ira")]],
      ["after combined short flags and a grep", ["-xg", "foo", "wm/site"], (l) => ["-xg", "foo", l("wm/site")]],
      ["after a combined optional value taken", ["-xu", "all", "ira"], (l) => ["-xu", "all", l("ira")]],
      ["after a combined optional value left", ["-xu", "--headed", "ira"], (l) => ["-xu", "--headed", l("ira")]],
      ["after a short flag with its value attached", ["-j2", "ira"], (l) => ["-j2", l("ira")]],
      ["after combined flags with the value attached", ["-xj2", "ira"], (l) => ["-xj2", l("ira")]],
      ["after a flag with every project", ["--project", "desktop", "mobile", "--headed", "ira"], (l) => ["--project", "desktop", "mobile", "--headed", l("ira")]],
    ])("finds the word %s", async (_, args, expected) => {
      const dir = sequences();
      const r = await bin(dir, args).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(dir)).toEqual([[...base, ...expected((id) => lit(dir, id))]]);
    });

    it("leaves a line with no word, a variadic or optional value that looks like one, and everything after a `--`, as given", async () => {
      const dir = sequences();
      write(join(dir, "snapseq.config.ts"), 'throw new Error("config loaded");'); // the parent does not read it for these
      const lines = [[], ["--headed"], ["--project", "desktop", "mobile", "cll/dosing"], ["--debug", "cll/dosing"], ["-g", "foo", "--", "cll", "ira"], ["--", "cll/*"], ["-xj", "2"], ["-xg", "foo"], ["-j2"]];
      for (const args of lines) {
        const r = await bin(dir, args).closed;
        expect(r.status, r.out).toBe(0);
      }
      expect(given(dir)).toEqual(lines.map((args) => [...base, ...args]));
    });

    it("stops a word with no sequence before the lock and the cache of --run are touched", async () => {
      const dir = sequences();
      const runs = join(dir, "node_modules/.cache/snapseq/runs");
      write(join(runs, "x.json"), "{}");
      const r = await bin(dir, ["--run", "x", "zzz"]).closed;
      expect(r.status).toBe(1);
      expect(r.out).toContain('snapseq: no sequence matches "zzz"');
      expect(readdirSync(runs)).toEqual(["x.json"]); // no lock written, the cache still there
      expect(given(dir)).toEqual([]);
    });

    it("takes a sequence file as its id, and any other file as a shell's expansion of an unquoted glob", async () => {
      const dir = sequences();
      write(join(dir, "snapseq/cll/dosing.sequence.md"));
      write(join(dir, "snapseq/notes.md"));
      write(join(dir, "cll/dosing.sequence.md"));
      write(join(dir, "other.seq.ts"));
      const file = await bin(dir, ["snapseq/cll/dosing.seq.ts"]).closed;
      expect(file.status, file.out).toBe(0);
      expect(given(dir)).toEqual([[...base, lit(dir, "cll/dosing")]]);
      // the glob to quote is over ids, so relative to the sequences folder; none for a file outside it
      for (const [word, glob] of [["snapseq/cll/dosing.sequence.md", ": 'cll/*'"], ["snapseq/notes.md", ": '*'"], ["cll/dosing.sequence.md", ""], ["other.seq.ts", ""]] as const) {
        const r = await bin(dir, [word]).closed;
        expect(r.status).toBe(1);
        expect(r.out).toContain(`snapseq: ${word} is not a sequence file; quote a glob so the shell leaves it${glob}\n`);
      }
      expect(given(dir)).toHaveLength(1); // only the first started Playwright
    });

    it("selects only the sequence file named, even when its name is a glob that selects its neighbours", async () => {
      const dir = plainPlaywright(project());
      rmSync(join(dir, "snapseq"), { recursive: true });
      for (const id of ["[ab]", "a", "b"]) write(join(dir, `snapseq/${id}.seq.ts`));
      const r = await bin(dir, ["snapseq/[ab].seq.ts"]).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(dir)).toEqual([[...base, lit(dir, "[ab]")]]);
    });

    it("stops a leading ! before the lock, though Node reads !(cll)/** as every other sequence", async () => {
      const dir = sequences();
      const runs = join(dir, "node_modules/.cache/snapseq/runs");
      write(join(runs, "x.json"), "{}");
      const r = await bin(dir, ["--run", "x", "!(cll)/**"]).closed;
      expect(r.status).toBe(1);
      expect(r.out).toContain('snapseq: no sequence matches "!(cll)/**"');
      expect(readdirSync(runs)).toEqual(["x.json"]);
      expect(given(dir)).toEqual([]);
    });

    it("says when only the case keeps a word from selecting", async () => {
      const dir = sequences();
      const r = await bin(dir, ["CLL/*"]).closed;
      expect(r.status).toBe(1);
      expect(r.out).toContain('snapseq: no sequence matches "CLL/*"\n  case matters: it would select cll/dosing, cll/efficacy-safety-resources, cll/home-resonate-2\n');
      expect(r.out).not.toContain("sequences:");
    });

    it("keeps a line break in a path inside the regex literal Playwright reads as one", async () => {
      const dir = sequences();
      const file = join(dir, "snapseq/we\nird/a.seq.ts");
      write(file);
      const r = await bin(dir, ["we\nird/a"]).closed;
      expect(r.status, r.out).toBe(0);
      const [arg] = given(dir)[0]!.slice(3);
      const literal = /^\/(.*)\/$/.exec(arg!); // Playwright's forceRegExp: `.` stops at a line break
      expect(literal).not.toBeNull();
      expect(new RegExp(literal![1]!).test(file)).toBe(true);
      expect(new RegExp(literal![1]!).test(file.replace("\n", " "))).toBe(false);
    });

    // jiti imports a .cjs or .mjs config natively, so Node caches it and Playwright's own load of it, in the same process, reuses what the parent made.
    it.each(["cjs", "mjs"])("loads a .%s config under the --env and --host Playwright's own load of it will see", async (ext) => {
      const dir = sequences();
      const config = `{ envs: { dev: { host: "https://dev.example" }, uat: { host: "https://uat.example" } }, defaultEnv: "dev", devices: { desktop: {} }, sequencesDir: "snapseq", screenshotsDir: "screenshots", numbering: "00", format: {}, stabilize: {} }`;
      const seen = `JSON.stringify([process.env.SNAPSEQ_ENV ?? null, process.env.SNAPSEQ_HOST ?? null]) + "\\n"`;
      write(
        join(dir, `snapseq.config.${ext}`),
        ext === "cjs"
          ? `require("node:fs").appendFileSync("loads.jsonl", ${seen});\nmodule.exports = { [Symbol.for("snapseq.inputs")]: { protocol: 1, config: ${config} } };\n`
          : `import { appendFileSync } from "node:fs";\nappendFileSync("loads.jsonl", ${seen});\nexport default { [Symbol.for("snapseq.inputs")]: { protocol: 1, config: ${config} } };\n`,
      );
      // as Playwright loads a config in its own process: require() a CommonJS one, import() a module
      write(
        join(dir, "node_modules/@playwright/test/cli.js"),
        `import { appendFileSync } from "node:fs";\nimport { createRequire } from "node:module";\nimport { resolve } from "node:path";\nimport { pathToFileURL } from "node:url";\n` +
          `appendFileSync("argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
          `const file = resolve(process.argv[process.argv.indexOf("-c") + 1]);\n` +
          `if (file.endsWith(".mjs")) await import(pathToFileURL(file).href); else createRequire(import.meta.url)(file);\n`,
      );
      const r = await bin(dir, ["-c", `snapseq.config.${ext}`, "--env", "uat", "--host", "https://uat.example", "cll/dosing"]).closed;
      expect(r.status, r.out).toBe(0);
      const loads = readFileSync(join(dir, "loads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(loads.length).toBeGreaterThan(0);
      expect(loads.every((seen) => seen[0] === "uat" && seen[1] === "https://uat.example"), JSON.stringify(loads)).toBe(true);
    });

    it("names files by the config's own path, as Playwright walks them, when that goes through a symlink", async () => {
      const dir = sequences();
      const alias = join(project(), "alias");
      symlinkSync(dir, alias);
      const elsewhere = plainPlaywright(project());
      const r = await bin(elsewhere, ["-c", join(alias, "snapseq.config.ts"), "cll/dosing"]).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(elsewhere)).toEqual([["test", "-c", join(alias, "snapseq.config.ts"), lit(alias, "cll/dosing")]]);
    });

    it("leaves the words to Playwright for a config folder that has no snapseq config", async () => {
      const dir = sequences();
      const empty = plainPlaywright(project()); // the Playwright beside the config it names
      rmSync(join(empty, "snapseq.config.ts"));
      const r = await bin(dir, ["-c", empty, "cll"]).closed;
      expect(r.status, r.out).toBe(0);
      expect(given(dir)).toEqual([["test", "-c", empty, "cll"]]);
    });
  });

  it("prints the usage for -h, with -o in it, without starting anything", async () => {
    const dir = plainPlaywright(project());
    const { status, out } = await bin(dir, ["-h"]).closed;
    expect(status).toBe(0);
    expect(out).toContain("snapseq -o <name> [--run <name> [sequence...] [--device <name>]] [options]");
    expect(out).toContain("  -o <name>  ");
    expect(given(dir)).toEqual([]);
  });

  it("runs -o <name> as an orchestration, and stops a lone -o with the names", async () => {
    const dir = fakePlaywright(project());
    script(dir, `await run("${LAUNCH}", { devices: ["desktop"] });`);
    const r = await bin(dir, ["-o", "spring", "-c", dir, "--run", "r1"]).closed;
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("  snapseq  spring.orchestration.ts  r1\n");
    expect(r.out).toContain(`reshoot one part: snapseq -o spring -c ${dir} --run r1 <sequence> --device <device>\n`);
    for (const args of [["-o"], ["-o", "--list"], ["-o", "--run"], ["-o", "--device", "desktop"]]) {
      const lone = await bin(dir, args).closed;
      expect(lone.status, lone.out).toBe(1);
      expect(lone.out).toContain("snapseq: -o needs an orchestration name; orchestrations: spring");
    }
  });
});
