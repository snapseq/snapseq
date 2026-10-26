import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeProject, pdfPages, pngSize, snapseq, startServer } from "./helpers";

// The orchestration mode of the built CLI: a `*.orchestration.ts` file run() s sequences, one child Playwright each,
// then label() and pdf() work over the captures. Fixtures are in ./fixtures; the failure rows are written inline.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

type Server = Awaited<ReturnType<typeof startServer>>;
let dev: Server;
let uat: Server;
const dirs: string[] = [];

const config = () => `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${dev.url}" }, uat: { host: "${uat.url}" } },
  devices: {
    desktop: { viewport: { width: 400, height: 300 } },
    mobile: { viewport: { width: 300, height: 400 }, deviceScaleFactor: 2 },
  },
});
`;

/** Every file under `dir`, relative and sorted. */
const files = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
const mtimes = (dir: string) => Object.fromEntries(files(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));

beforeAll(async () => {
  dev = await startServer();
  uat = await startServer();
});
afterAll(async () => {
  await Promise.all([dev.close(), uat.close()]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// The tests in this block build on each other: the run they share is shot first, repaired, then hand-reshot.
describe("an orchestration with three parts, label and pdf", () => {
  let project: string;
  let run: string;
  // Which devices each part of proof.orchestration.ts shoots, and two shots per device: the first labelled.
  const parts: Record<string, string[]> = {
    "10-launch": ["desktop"],
    "20-offer": ["desktop", "mobile"],
    "30-reminder": ["desktop", "mobile", "tablet"],
  };
  const SIZES: Record<string, [number, number]> = { desktop: [400, 300], mobile: [600, 800], tablet: [500, 300] };
  const layout = [
    ...Object.entries(parts).flatMap(([sequence, devices]) =>
      devices.flatMap((device) =>
        ["01.png", "02.png"].flatMap((n) => [`${sequence}/${device}/${n}`, `${sequence}/${device}/labelled/${n}`]),
      ),
    ),
    "desktop.pdf",
    "mobile.pdf",
    "tablet.pdf",
  ].sort();
  const orchestrate = (args: string[], env: Record<string, string> = {}) =>
    snapseq(project, ["snapseq/proof.orchestration.ts", ...args], { CI: "", ...env });
  // `1 passed, 5 reused  12 shots  4s  screenshots/review-1`: the time varies.
  const footer = (counts: string, name = "review-1") =>
    new RegExp(`^ {2}${counts} {2}12 shots {2}(\\d+m )?\\d+s {2}screenshots/${name}$`, "m");

  beforeAll(() => {
    project = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "proof.orchestration.ts": fixture("proof.orchestration.ts"),
        "10-launch.seq.ts": fixture("10-launch.seq.ts"),
        "20-offer.seq.ts": fixture("20-offer.seq.ts"),
        "30-reminder.seq.ts": fixture("30-reminder.seq.ts"),
      },
    });
    dirs.push(project);
    run = join(project, "screenshots", "review-1");
  });

  it("shoots the parts, labels them into labelled/ and binds one PDF per device", async () => {
    const r = await orchestrate(["--run", "review-1"]);
    expect(r.status, r.out).toBe(0);
    // The parent's own lines: heading, footer (six sequence-device tests, twelve shots), and the hint for a repair.
    expect(r.out).toMatch(/^ {2}snapseq {2}proof\.orchestration\.ts {2}review-1$/m);
    expect(r.out).toMatch(footer("6 passed"));
    expect(r.out).toContain("reshoot one part: snapseq snapseq/proof.orchestration.ts --run review-1 <sequence> --device <device>");
    expect(r.out).toContain("steps done");

    // Nothing else in the run folder: raw shots, their labelled copies, one PDF per device.
    expect(files(run)).toEqual(layout);

    // Raw files are the viewport; labelled ones carry a 24 px strip where the sequence labelled the shot.
    for (const [sequence, devices] of Object.entries(parts)) {
      for (const device of devices) {
        const dir = join(run, sequence, device);
        const [width, height] = pngSize(join(dir, "01.png"));
        expect([width, height]).toEqual(SIZES[device]);
        expect(pngSize(join(dir, "labelled", "01.png"))).toEqual([width, height + 24]);
        expect(pngSize(join(dir, "labelled", "02.png"))).toEqual(pngSize(join(dir, "02.png")));
      }
    }

    // Pages: desktop has all three parts' two shots, mobile two parts, tablet one. A page is the shot's CSS size at
    // 0.75 pt per px, so the labelled 2x phone shot (600 x 824 px) is 225 x 309 pt.
    expect((await pdfPages(join(run, "desktop.pdf"))).length).toBe(6);
    const mobile = await pdfPages(join(run, "mobile.pdf"));
    expect(mobile).toHaveLength(4);
    expect(mobile[0]).toEqual([225, 309]);
    expect(await pdfPages(join(run, "tablet.pdf"))).toHaveLength(2);
  });

  it("gives each part its own devices, env and stabilize", () => {
    // The env of 20-offer is uat: its server saw it, the dev server did not.
    const seen = (server: Server) => server.hits.map((h) => h.url).filter((u) => !u.startsWith("/favicon"));
    expect(seen(uat)).toEqual(expect.arrayContaining(["/offer?env=uat&device=desktop", "/offer?env=uat&device=mobile"]));
    expect(seen(uat).filter((u) => !u.startsWith("/offer"))).toEqual([]);
    expect(seen(dev).filter((u) => u.startsWith("/offer"))).toEqual([]);
    // 10-launch ran on desktop only; the dev server saw no mobile launch.
    expect(seen(dev).filter((u) => u.startsWith("/launch"))).toEqual(["/launch?env=dev&device=desktop"]);
    // 30-reminder added a tablet, and its run turned reducedMotion on for all three devices.
    expect(seen(dev).filter((u) => u.startsWith("/reminder?"))).toEqual(
      ["desktop", "mobile", "tablet"].map((d) => `/reminder?device=${d}&reduced=true`),
    );
  });

  it("a repair reshoots the matching part, takes the rest from the run's cache and runs every step again", async () => {
    const before = mtimes(run);
    const hits = { dev: dev.hits.length, uat: uat.hits.length };
    const r = await orchestrate(["--run", "review-1", "20-offer", "--device", "mobile"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/^ {2}snapseq {2}proof\.orchestration\.ts {2}review-1$/m);
    // The orchestration's own view of each capture, and the parent's line for each it did not shoot.
    expect(r.out).toContain("part 20-offer/mobile fresh env=uat");
    for (const part of ["10-launch/desktop", "20-offer/desktop", "30-reminder/desktop", "30-reminder/mobile", "30-reminder/tablet"]) {
      expect(r.out).toContain(`part ${part} reused`);
    }
    expect(r.out.match(/reused {2}2 shots/g)).toHaveLength(5);
    expect(r.out).toMatch(footer("1 passed, 5 reused"));
    expect(r.out).not.toContain("reshoot one part");

    // Only the one device was visited.
    expect(dev.hits.length).toBe(hits.dev);
    expect(uat.hits.slice(hits.uat).map((h) => h.url)).toEqual(["/offer?env=uat&device=mobile"]);

    const after = mtimes(run);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const [file, time] of Object.entries(after)) {
      const raw = /^[^/]+\/[^/]+\/\d\d\.png$/.test(file);
      if (file.startsWith("20-offer/mobile/") && raw) expect(time, file).toBeGreaterThan(before[file]!);
      else if (raw) expect(time, file).toBe(before[file]); // reused: not touched
      else expect(time, file).toBeGreaterThan(before[file]!); // labelled copies and PDFs: rebuilt
    }
    expect(await pdfPages(join(run, "desktop.pdf"))).toHaveLength(6);
    expect(await pdfPages(join(run, "mobile.pdf"))).toHaveLength(4);
  });

  it("an ordinary run into the run drops its cache, so the next repair builds that part", async () => {
    // The plain mode: Playwright's own filter, here both devices of 20-offer, into the same run.
    const plain = await snapseq(project, ["20-offer", "--run", "review-1"], { CI: "" });
    expect(plain.status, plain.out).toBe(0);
    // The sequence's folders were wiped, the labelled copies in them with them.
    expect(files(run).filter((f) => f.startsWith("20-offer/"))).toEqual(["20-offer/desktop/01.png", "20-offer/desktop/02.png", "20-offer/mobile/01.png", "20-offer/mobile/02.png"]);

    const hits = uat.hits.length;
    const r = await orchestrate(["--run", "review-1", "10-launch", "--device", "desktop"]);
    expect(r.status, r.out).toBe(0);
    // 20-offer is not what the filter names, yet it is built: the plain run left nothing to reuse.
    expect(r.out).toMatch(/20-offer \/ desktop \(uat\) +building, no capture yet/);
    expect(r.out).toMatch(/20-offer \/ mobile \(uat\) +building, no capture yet/);
    expect(r.out).toContain("part 20-offer/desktop fresh env=uat");
    expect(r.out).toContain("part 20-offer/mobile fresh env=uat");
    expect(r.out).not.toContain("part 20-offer/desktop reused");
    expect(uat.hits.slice(hits).map((h) => h.url)).toEqual(["/offer?env=uat&device=desktop", "/offer?env=uat&device=mobile"]);
    // The run is whole again.
    expect(files(run)).toEqual(layout);
  });

  it("a plain run still writes raw shots only, on the config's devices and with stabilize as configured", async () => {
    const hits = dev.hits.length;
    const r = await snapseq(project, ["30-reminder", "--run", "plain"], { CI: "" });
    expect(r.status, r.out).toBe(0);
    // No labelled copies, no PDFs, no tablet: those are the orchestration's.
    expect(files(join(project, "screenshots", "plain"))).toEqual([
      "30-reminder/desktop/01.png",
      "30-reminder/desktop/02.png",
      "30-reminder/mobile/01.png",
      "30-reminder/mobile/02.png",
    ]);
    // Without the run's stabilize override the page keeps its own motion preference.
    expect(dev.hits.slice(hits).map((h) => h.url).filter((u) => u.startsWith("/reminder?"))).toEqual([
      "/reminder?device=desktop&reduced=false",
      "/reminder?device=mobile&reduced=false",
    ]);
  });
});

// One small orchestration per row of the run() semantics table. `body` is inside `defineOrchestration(async ({ run }) => { … })`,
// whose first line is line 3 of the file; `{file}` stands for the file's name in the message's call site.
const SEQUENCES = {
  "ok.seq.ts": `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => { await page.goto("/ok"); await seq.snap(); });
`,
  // Decomposed, as macOS may store a name: the orchestration asks for it composed.
  ["caf\u0065\u0301.seq.ts"]: `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => { await page.goto("/ok"); await seq.snap(); });
`,
  "boom.seq.ts": `import { sequence } from "snapseq";
sequence(async ({ page, seq, device }) => {
  await page.goto("/boom");
  await seq.snap();
  if (device === "mobile") throw new Error("kaput");
});
`,
  "fails.seq.ts": `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => { await page.goto("/fails"); await seq.snap(); throw new Error("kaput"); });
`,
  "skipme.seq.ts": `import { sequence, skipIf } from "snapseq";
skipIf(({ device }) => device === "mobile", "no mobile layout");
sequence(async ({ page, seq }) => { await page.goto("/skipme"); await seq.snap(); });
`,
  "noseq.seq.ts": `import { sequence } from "snapseq";
sequence(async ({ page }) => { await page.goto("/noseq"); });
`,
  "two.seq.ts": `import { sequence } from "snapseq";
import { test } from "@playwright/test";
sequence(async ({ page, seq }) => { await page.goto("/two"); await seq.snap(); });
test("second", async () => {});
`,
  "titled.seq.ts": `import { sequence } from "snapseq";
import { test } from "@playwright/test";
test.describe("hero", () => sequence(async ({ seq }) => void seq.dir));
`,
  "elsewhere.seq.ts": `import { sequence } from "snapseq";
import { test } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:1" });
sequence(async ({ seq }) => void seq.dir);
`,
  "dangling.seq.ts": `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/dangling");
  void seq.snap();
});
`,
};

const ROWS: { name: string; body: string; says: string[]; keeps?: string[] }[] = [
  {
    name: "a failing sequence names the part and the call site; the other parts' files stay",
    body: `await run("ok");\nawait run("boom");`,
    says: ["boom failed on mobile ({file}:4)", "3 passed, 1 failed"],
    keeps: ["ok/desktop/01.png", "ok/mobile/01.png", "boom/desktop/01.png"],
  },
  {
    name: "a failure stops the later devices, which are reported as not run",
    body: `await run("fails");`,
    says: ["fails failed on desktop, not run on mobile after desktop failed ({file}:3)"],
  },
  {
    name: "a file-level skipIf names its reason",
    body: `await run("skipme");`,
    says: ['skipme was skipped on mobile: "no mobile layout" ({file}:3)'],
    keeps: ["skipme/desktop/01.png"],
  },
  {
    name: "a sequence that never uses seq is refused",
    body: `await run("noseq", { devices: ["mobile"] });`,
    says: ["noseq never used seq on mobile ({file}:3)"],
  },
  {
    name: "a file with a second test is refused",
    body: `await run("two");`,
    says: ["two ran 2 tests; one sequence per file ({file}:3)"],
  },
  {
    name: "a run() nobody awaited is refused when the orchestration ends",
    body: `run("ok");`,
    says: ['run("ok") was not awaited; the orchestration finished first ({file}:3)'],
  },
  {
    name: "a file whose test is under a describe, or is a second one, runs as another id and is refused",
    body: `await run("titled", { devices: ["desktop"] });`,
    says: ['this file runs as "titled"; a describe title or a second test changes the id to "titled/hero/sequence"'],
  },
  {
    name: "a context whose baseURL is not the run's host is refused",
    body: `await run("elsewhere", { devices: ["desktop"] });`,
    says: ['the context\'s baseURL "http://127.0.0.1:1" is not this run\'s host'],
  },
  {
    name: "a sequence that ends with a shot still being taken is refused",
    body: `await run("dangling", { devices: ["desktop"] });`,
    says: ["a shot was still being taken when the sequence ended"],
  },
];

describe("an orchestration that goes wrong", () => {
  let project: string;
  const wrap = (body: string) => `import { defineOrchestration } from "snapseq";\nexport default defineOrchestration(async ({ run }) => {\n${body}\n});\n`;

  beforeAll(() => {
    project = makeProject({
      esm: true,
      config: config(),
      sequences: {
        ...SEQUENCES,
        ...Object.fromEntries(ROWS.map((row, i) => [`row${i}.orchestration.ts`, wrap(row.body)])),
        "nomatch.orchestration.ts": wrap(`await run("ok");\nconsole.log("script done");`),
        "cafe.orchestration.ts": wrap(`await run("café", { devices: ["desktop"] });`),
      },
    });
    dirs.push(project);
  });

  it.each(ROWS.map((row, i) => [row.name, i] as const))("%s", async (_name, i) => {
    const row = ROWS[i]!;
    const file = `row${i}.orchestration.ts`;
    const run = join(project, "screenshots", `row${i}`);
    const r = await snapseq(project, [`snapseq/${file}`, "--run", `row${i}`], { CI: "" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("failed  ");
    for (const says of row.says) expect(r.out).toContain(says.replaceAll("{file}", file));
    for (const kept of row.keeps ?? []) expect(statSync(join(run, kept)).size, kept).toBeGreaterThan(0);
    // However it ended, no lock or request file is left behind.
    const cache = join(project, "node_modules", ".cache", "snapseq");
    expect(readdirSync(join(cache, "runs")).filter((f) => f.endsWith(".lock"))).toEqual([]);
    expect(readdirSync(join(cache, "requests"))).toEqual([]);
  });

  it("a filter that matches nothing ends the run with exit 1 after the script completed", async () => {
    const first = await snapseq(project, ["snapseq/nomatch.orchestration.ts", "--run", "again"], { CI: "" });
    expect(first.status, first.out).toBe(0);
    const r = await snapseq(project, ["snapseq/nomatch.orchestration.ts", "--run", "again", "nothing-like-this"], { CI: "" });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('failed  no part matched "nothing-like-this"');
    expect(r.out.indexOf("script done")).toBeGreaterThan(-1);
    expect(r.out.indexOf("script done")).toBeLessThan(r.out.indexOf("no part matched"));
    // The part it did not shoot came from the cache.
    expect(r.out).toMatch(/ok \/ desktop +reused {2}1 shot/);
  });

  it("runs a file the disk names decomposed as the composed id the orchestration asked for", async () => {
    const r = await snapseq(project, ["-o", "cafe", "--run", "cafe"], { CI: "" });
    expect(r.status, r.out).toBe(0);
    expect(statSync(join(project, "screenshots", "cafe", "caf\u0065\u0301", "desktop", "01.png")).size).toBeGreaterThan(0);
  });
});
