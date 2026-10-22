import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// What defineConfig keeps for the parent, faked: the real one is being reworked alongside.
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
export default { [Symbol.for("snapseq.inputs")]: { config, overrides: [] } };
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
  request: Record<string, unknown> & { deviceOrder: string[]; sequence: string };
  env: Record<string, string | null>;
  cacheAtStart: { entries: Record<string, unknown> } | null;
}

/** Writes `body` as the orchestration's function body (its first line is line 2 of `name`) and runs it. */
async function orchestrate(dir: string, body: string, args: string[] = [], name = "spring") {
  const file = join(dir, `snapseq/${name}.orchestration.ts`);
  writeFileSync(file, `export default async ({ run, config, dir }: any) => {\n${body}\n};\n`);
  let out = "";
  const code = await main([file, "-c", join(dir, "snapseq.config.ts"), ...args], {
    findConfig: (given) => given!,
    playwrightCli: () => FAKE,
    stdout: { write: (s: string) => (out += s) },
    now: () => 0,
  });
  const log = join(dir, "calls.jsonl");
  const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  rmSync(log, { force: true });
  return { code, out, calls, file };
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
      version: 1,
      sequence: LAUNCH,
      file: join(dir, `snapseq/${LAUNCH}.seq.ts`),
      snapseq: { devices: { desktop: { viewport: { width: 1920, height: 1080 } }, mobile: { viewport: { width: 390, height: 844 } } } },
      deviceOrder: ["desktop", "mobile"],
      playwright: [],
      // The widest id in snapseq/ (19), " / ", the widest device (7), the widest env a call could show, " (uat)".
      terminal: { labelWidth: 35, showEnv: false },
    });
    expect(dirname(call!.requestFile)).toBe(join(dir, "node_modules/.cache/snapseq/requests"));
    expect(existsSync(call!.requestFile)).toBe(false);
    expect(call!.env).toEqual({ SNAPSEQ_ENV: null, SNAPSEQ_HOST: null, SNAPSEQ_RUN: "r1", SNAPSEQ_OPEN: "0", SNAPSEQ_RECORD: null, SNAPSEQ_RESULT_FD: "3" });

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
    expect(call!.request.snapseq).toEqual({ numbering: "000", stabilize: { motion: false }, devices: { mobile: { viewport: { width: 390, height: 844 } } } });
    expect(call!.request.deviceOrder).toEqual(["mobile"]);
    expect(call!.request.playwright).toEqual([{ timeout: 60000 }]);
    expect(call!.request.terminal).toEqual({ labelWidth: 35, showEnv: true }); // " (uat)" on every row
    expect(call!.env).toMatchObject({ SNAPSEQ_ENV: "uat", SNAPSEQ_HOST: "https://h.example" });
  });

  it("pads every child's rows to one width, the widest env any call could show included", async () => {
    const dir = project();
    const r = await orchestrate(dir, `await run("${LAUNCH}"); await run("${OFFER}", { env: "uat" });`, ["--run", "r1"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => c.request.terminal)).toEqual([{ labelWidth: 35, showEnv: false }, { labelWidth: 35, showEnv: true }]);
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
    ["a test that never used seq", { devices: { mobile: { usedSeq: false } } }, `${LAUNCH} never used seq on mobile ${site}`],
    ["two tests in the file", { tests: 2 }, `${LAUNCH} ran 2 tests; one sequence per file ${site}`],
    ["a child that died before reporting", { report: "none", exit: 1 }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    ["a zero exit without a report", { report: "none", exit: 0 }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    ["a report that is not JSON", { report: "garbage" }, `${LAUNCH}: child exited before reporting; see the output above ${site}`],
    [
      "an error outside any test",
      { devices: { desktop: { status: "not run" }, mobile: { status: "not run" } }, errors: ["Error: Timed out waiting 120000ms from config.webServer.\n  at x"] },
      `${LAUNCH}: Timed out waiting 120000ms from config.webServer. ${site}`,
    ],
    ["a retried test", { devices: { mobile: { retry: 1 } } }, `${LAUNCH} was retried on mobile; retries must be 0 ${site}`],
    ["a test given retries that passed at once", { devices: { mobile: { retries: 1 } } }, `${LAUNCH} is configured with retries on mobile; retries must be 0 ${site}`],
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
    expect(r.calls.map((c) => c.request.deviceOrder)).toEqual([["desktop", "mobile"], ["mobile"]]);
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
    expect(r.calls.map((c) => c.request.deviceOrder)).toEqual([["desktop", "mobile"], ["desktop", "mobile"]]);
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
    const r = await repair(dir, ["12346", "--device", "mobile"]);
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => [c.request.sequence, c.request.deviceOrder])).toEqual([[OFFER, ["mobile"]]]);
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
    expect(r.calls.map((c) => [c.request.sequence, c.request.deviceOrder])).toEqual([[LAUNCH, ["desktop"]]]);
    expect(r.out).toContain('failed  no part matched "zzz"');
  });

  it("need --run naming an earlier run, checked before the orchestration loads", async () => {
    const dir = project();
    const file = join(dir, "snapseq/never.orchestration.ts");
    const options = { findConfig: (c: string | undefined) => c!, playwrightCli: () => FAKE, stdout: { write: () => true } };
    await expect(main([file, "12346"], options)).rejects.toThrow(
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
});
