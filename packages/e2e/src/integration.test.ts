import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, FONT, PKG, makeProject, playwright, pngSize, snapseq, startServer } from "./helpers";

// Drives the BUILT package through the real Playwright CLI, the way a consumer would.
const REPORTER = join(PKG, "dist", "reporter.js");
// The notes the run printed for the shots taken at `url`, in order: `snapseq: 01.png taken with <notes>  <url>`.
const noted = (out: string, url: string) => (out.match(/snapseq: \d+\.png taken with .*/g) ?? []).filter((line) => line.endsWith(`  ${url}`));

const sequenceA = `
import { sequence } from "snapseq";
sequence(async ({ page, seq, ctx, env, device }) => {
  if (ctx.env !== env || ctx.device !== device || ctx.seq !== seq) throw new Error("ctx mismatch");
  await page.goto("/a?env=" + env + "&device=" + device);
  await seq.snap();
  await seq.snapPage();
});
`;

const sequenceB = `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/b");
  await seq.snap();
});
`;

// A file-level skip must run before the seq fixture, so the skipped device gets
// no directory at all.
const sequenceC = `
import { sequence, skipIf } from "snapseq";
skipIf(({ device }) => device !== "d1", "d1 only");
sequence(async ({ page, seq }) => { await page.goto("/c"); await seq.snap(); });
`;

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });
}

async function portClosed(port: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const closed = await new Promise<boolean>((ok) => {
      const s = connect({ port, host: "127.0.0.1" });
      s.once("connect", () => (s.destroy(), ok(false)));
      s.once("error", () => ok(true));
    });
    if (closed) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let server: Awaited<ReturnType<typeof startServer>>;
let project: string;
const dirs: string[] = [];

beforeAll(async () => {
  server = await startServer();
  project = makeProject({
    esm: true,
    config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" }, dead: { host: "http://127.0.0.1:9" } },
  devices: {
    d1: { viewport: { width: 400, height: 300 } },
    d2: { viewport: { width: 500, height: 300 } },
  },
  screenshotsDir: "out",
});
`,
    sequences: {
      "a.seq.ts": sequenceA,
      "nested/b.seq.ts": sequenceB,
      "c.seq.ts": sequenceC,
    },
  });
  dirs.push(project);
});

afterAll(async () => {
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("snapseq via the Playwright CLI", () => {
  it("writes numbered screenshots per sequence and project, wipes only its own dirs, self-gitignores, and de-headlesses the UA", async () => {
    const out = join(project, "out");
    mkdirSync(join(out, "run1", "a", "d1"), { recursive: true });
    writeFileSync(join(out, "run1", "a", "d1", "999.png"), "stale");
    mkdirSync(join(out, "unrelated", "d1"), { recursive: true });
    writeFileSync(join(out, "unrelated", "d1", "01.png"), "keep");

    const r = await playwright(project, []);
    expect(r.out).toContain("1 skipped");
    expect(r.out).toContain("5 passed");
    expect(r.out).toContain(`01.png  ${server.url}/a?env=dev&device=d1`); // the list reporter's step line
    expect(r.status).toBe(0);

    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["01.png", "02.png"]);
    expect(readdirSync(join(out, "run1", "a", "d2")).sort()).toEqual(["01.png", "02.png"]);
    expect(readdirSync(join(out, "run1", "nested", "b", "d1")).sort()).toEqual(["01.png"]);
    // the skipped device has no dir
    expect(readdirSync(join(out, "run1", "c", "d1")).sort()).toEqual(["01.png"]);
    expect(existsSync(join(out, "run1", "c", "d2"))).toBe(false);
    expect(existsSync(join(out, "unrelated", "d1", "01.png"))).toBe(true);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("*\n");

    expect(pngSize(join(out, "run1", "a", "d1", "01.png"))).toEqual([400, 300]);
    expect(pngSize(join(out, "run1", "a", "d2", "01.png"))[0]).toBe(500);
    expect(pngSize(join(out, "run1", "a", "d1", "02.png"))[1]).toBeGreaterThan(300);

    const pageHits = server.hits.filter((h) => h.url.startsWith("/a") || h.url.startsWith("/b"));
    expect(pageHits.map((h) => h.url)).toContain("/a?env=dev&device=d1");
    expect(pageHits.length).toBeGreaterThan(0);
    for (const h of pageHits) {
      expect(h.ua).toContain("Chrome/");
      expect(h.ua).not.toContain("Headless");
    }
  });

  // The filter is a regex (Playwright's): the dot is escaped so a temp dir ending in "a" cannot match too.
  it("a file filter re-runs only that sequence", async () => {
    const out = join(project, "out");
    writeFileSync(join(out, "run1", "nested", "b", "d1", "stale.png"), "stale");
    const r = await playwright(project, ["a\\.seq", "--project", "d1"]);
    expect(r.out).toContain("1 passed");
    expect(existsSync(join(out, "run1", "nested", "b", "d1", "stale.png"))).toBe(true);
    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["01.png", "02.png"]);
  });

  it("SNAPSEQ_ENV picks the env and SNAPSEQ_HOST overrides its host", async () => {
    const before = server.hits.length;
    const r = await playwright(project, ["a\\.seq", "--project", "d1"], {
      SNAPSEQ_ENV: "dead",
      SNAPSEQ_HOST: server.url,
    });
    expect(r.status).toBe(0);
    expect(server.hits.slice(before).map((h) => h.url)).toContain("/a?env=dead&device=d1");
  });

  it("--env without --host drops an inherited SNAPSEQ_HOST, so the run goes to that env's host", async () => {
    const before = server.hits.length;
    const r = await snapseq(project, ["a\\.seq", "--device", "d1", "--env", "dev"], { SNAPSEQ_HOST: "http://127.0.0.1:1" });
    expect(r.status, r.out).toBe(0);
    expect(server.hits.slice(before).map((h) => h.url)).toContain("/a?env=dev&device=d1");
  });

  it("rejects an unknown env at config load", async () => {
    const r = await playwright(project, [], { SNAPSEQ_ENV: "nope" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('unknown env "nope"');
  });

  it("rejects --repeat-each", async () => {
    const r = await playwright(project, ["a\\.seq", "--project", "d1", "--repeat-each", "2"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("not supported");
  });

  it("sends env httpCredentials to the env's origin and to no other, and loads under CommonJS", async () => {
    const other = await startServer(); // a second origin that challenges with Basic auth too
    const cjs = makeProject({
      esm: false,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}", httpCredentials: { username: "u", password: "p" } } },
  devices: { d1: { viewport: { width: 320, height: 200 } } },
  format: { type: "jpeg", quality: 50 },
});
`,
      sequences: {
        "p.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  const res = await page.goto("/protected/x");
  if (res?.status() !== 200) throw new Error("status " + res?.status());
  // A third-party image behind the same kind of challenge must not get the password.
  await page.evaluate((src) => new Promise((done) => {
    const img = new Image();
    img.onload = () => done(undefined);
    img.onerror = () => done(undefined);
    img.src = src;
    document.body.appendChild(img);
  }), "${other.url}/protected/i.png");
  await seq.snap();
});
`,
      },
    });
    dirs.push(cjs);
    // The built reporter, loaded by a CommonJS consumer.
    const r = await playwright(cjs, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  1 shot  screenshots/run1");
    expect(r.status).toBe(0);
    const shot = readFileSync(join(cjs, "screenshots", "run1", "p", "d1", "01.jpg"));
    expect([...shot.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // a JPEG, by its magic bytes
    expect(server.hits.some((h) => h.url === "/protected/x" && h.auth === AUTH)).toBe(true);
    expect(other.hits.map((h) => h.url)).toContain("/protected/i.png");
    expect(other.hits.filter((h) => h.auth)).toEqual([]);
    await other.close();
  });

  it("refuses a run name that leaves the screenshots dir, before anything is wiped", async () => {
    // Where SNAPSEQ_RUN=../outside would put sequence a on d1, and wipe.
    const sentinel = join(project, "outside", "a", "d1", "keep.txt");
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "keep");
    const r = await playwright(project, ["a\\.seq", "--project", "d1"], { SNAPSEQ_RUN: "../outside" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('SNAPSEQ_RUN must be a directory name, not a path: "../outside"');
    expect(existsSync(sentinel)).toBe(true);
  });

  it("refuses to wipe a sequence's directory that another sequence writes into, and deletes nothing", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } }, d2: { viewport: { width: 500, height: 300 } } },
  screenshotsDir: "out",
});
`,
      // home/d1.seq.ts writes home/d1/<device>/, inside what home.seq.ts on d1 wipes.
      sequences: { "home.seq.ts": sequenceB, "home/d1.seq.ts": sequenceB },
    });
    dirs.push(p);
    const theirs = join(p, "out", "run1", "home", "d1", "d2", "01.png");
    const mine = join(p, "out", "run1", "home", "d1", "01.png");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "keep");
    writeFileSync(mine, "stale");
    const r = await playwright(p, ["home\\.seq", "--project", "d1"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`refusing to wipe ${join("run1", "home", "d1")}: home/d1 writes inside it; rename one of the sequences`);
    expect(readFileSync(theirs, "utf8")).toBe("keep");
    expect(readFileSync(mine, "utf8")).toBe("stale");
  });
});

describe("snapseq bin", () => {
  it("translates --env, --host and --device, and finds the config in cwd", async () => {
    const before = server.hits.length;
    const r = await snapseq(project, [
      "a\\.seq",
      "--device",
      "d1",
      "--env",
      "dead",
      "--host",
      server.url,
    ]);
    expect(r.out).toContain("1 passed");
    expect(r.status).toBe(0);
    expect(server.hits.slice(before).map((h) => h.url)).toContain("/a?env=dead&device=d1");
  });

  it("passes unknown flags through to playwright test", async () => {
    const r = await snapseq(project, ["a\\.seq", "--device=d1", "--list"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Total: 1 test in 1 file");
  });

  it("prints its own usage for --help", async () => {
    const r = await snapseq(project, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("--device <name>");
  });

  it("fails clearly when no config is in cwd", async () => {
    const r = await snapseq(project, [], {}, join(project, "snapseq"));
    expect(r.status).toBe(1);
    expect(r.out).toContain("no snapseq.config.ts in");
  });
});

describe("webServer", () => {
  it("starts the env's command, stops it after the run, and never starts it for an overridden host", async () => {
    const port = await freePort();
    const ws = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "http://127.0.0.1:${port}", webServer: "node server.mjs ${port}" } },
  devices: { d1: { viewport: { width: 320, height: 200 } } },
});
`,
      sequences: {
        "w.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => { await page.goto("/w"); await seq.snap(); });
`,
      },
    });
    dirs.push(ws);
    // Marks that it ran (cwd is the config dir), then serves 200 on the given port.
    writeFileSync(
      join(ws, "server.mjs"),
      `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync("started", "");
createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>w</h1>"); })
  .listen(Number(process.argv[2]), "127.0.0.1");
`,
    );

    const r = await playwright(ws, []);
    expect(r.out).toContain("1 passed");
    expect(r.status).toBe(0);
    expect(existsSync(join(ws, "started"))).toBe(true);
    expect(existsSync(join(ws, "screenshots", "run1", "w", "d1", "01.png"))).toBe(true);
    expect(await portClosed(port)).toBe(true);

    rmSync(join(ws, "started"));
    const before = server.hits.length;
    const o = await playwright(ws, [], { SNAPSEQ_HOST: server.url });
    expect(o.status).toBe(0);
    expect(existsSync(join(ws, "started"))).toBe(false);
    expect(server.hits.slice(before).map((h) => h.url)).toContain("/w");
  });
});

describe("helpers", () => {
  it("disableTransitions persists across navigations, snapPage lets the page land and restores the viewport, snap passes options through", async () => {
    const p = makeProject({
      esm: true,
      // stabilize is on by default and would already have stopped the motion the fixture checks for.
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
  stabilize: false,
});
`,
      sequences: {
        // Fails unless the CSS applies to the current document AND survives two navigations.
        "motion.seq.ts": `
import { sequence, disableTransitions } from "snapseq";
sequence(async ({ page, seq }) => {
  const motion = () => page.evaluate(() => {
    const el = document.getElementById("spin");
    const fold = getComputedStyle(document.getElementById("fold"), "::details-content").transitionDuration;
    return getComputedStyle(document.documentElement).scrollBehavior + "/" + (el ? getComputedStyle(el).animationName : "?") + "/" + fold;
  });
  await page.goto("/motion");
  if ((await motion()) !== "smooth/spin/0.3s") throw new Error("fixture: " + (await motion()));
  await disableTransitions(page);
  if ((await motion()) !== "auto/none/0s") throw new Error("now: " + (await motion()));
  await page.goto("/motion?2");
  await page.goto("/motion?3");
  if ((await motion()) !== "auto/none/0s") throw new Error("later: " + (await motion()));
  await seq.snap();
});
`,
        "sticky.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/sticky");
  const before = page.viewportSize();
  await seq.snap({ fullPage: true }); // 001: Playwright's full page; the slot never comes into view
  await seq.snapPage();               // 002: tall viewport; the slot shows, the page grows by 100 px
  if (page.viewportSize()?.height !== before?.height) throw new Error("viewport not restored");
  await page.waitForFunction(() => !document.documentElement.classList.contains("landed"));
});
`,
        "clip.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/clip");
  await seq.snap({ clip: { x: 0, y: 0, width: 100, height: 50 } });
});
`,
        // Every shot waits for images: the lazy one below the fold is loaded when snapPage returns,
        // and the native full page forces it to start at all.
        "lazy.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  const loaded = () => page.evaluate(() => { const i = document.getElementById("lazy"); return i.complete && i.naturalWidth > 0; });
  await page.goto("/lazy");
  if (await loaded()) throw new Error("fixture: the lazy image loaded eagerly");
  await seq.snapPage();
  if (!(await loaded())) throw new Error("snapPage returned before the lazy image loaded");
  await page.goto("/lazy?2");
  await seq.snap({ fullPage: true });
  if (!(await loaded())) throw new Error("fullPage returned before the lazy image loaded");
  const chained = () => page.evaluate(() => { const b = document.getElementById("b"); return !!b && b.complete && b.naturalWidth > 0; });
  await page.goto("/chain");
  await page.getByRole("button", { name: "go" }).click();
  await seq.snap();
  if (!(await chained())) throw new Error("snap returned before the chained lazy image loaded");
  await page.goto("/chain?far");
  await page.getByRole("button", { name: "go" }).click();
  await seq.snap({ fullPage: true });
  if (!(await chained())) throw new Error("fullPage returned before the far chained lazy image loaded");
  await page.goto("/stall"); // three images that never answer
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t > 8000) throw new Error("stalled images were waited for one by one");
});
`,
        // snap waits for a quiet DOM: the shot lands after the 40-frame loop, and the 3 s cap releases it on a page that never quiets.
        "settle.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/jsmotion");
  await seq.snap();
  if ((await page.evaluate(() => document.documentElement.dataset.done)) !== "1") throw new Error("snapped mid-motion");
  await page.goto("/jsmotion?forever");
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t < 3000) throw new Error("released before the cap");
});
`,
      },
    });
    dirs.push(p);

    // The built reporter, loaded by an ESM consumer; stdout is a pipe, so it prints events and the summary.
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/ok\s+clip \/ d1\s+1 shot/);
    expect(r.out).toContain("5 passed  11 shots  out/run1");

    const out = join(p, "out", "run1");
    expect(existsSync(join(out, "motion", "d1", "01.png"))).toBe(true);
    expect(pngSize(join(out, "sticky", "d1", "01.png"))).toEqual([400, 960]); // native: not landed
    expect(pngSize(join(out, "sticky", "d1", "02.png"))).toEqual([400, 1060]); // snapPage: landed, re-measured
    expect(pngSize(join(out, "clip", "d1", "01.png"))).toEqual([100, 50]);
    // the lazy image loaded before the height was measured: 2000 px of page plus the 100 px image
    expect(pngSize(join(out, "lazy", "d1", "01.png"))).toEqual([400, 2100]);
    expect(pngSize(join(out, "lazy", "d1", "02.png"))).toEqual([400, 2100]);
    // A cap that released a wait is noted in the terminal; a shot that was ready says nothing.
    for (const quiet of ["/clip", "/jsmotion", "/lazy", "/lazy?2"]) expect(noted(r.out, server.url + quiet), quiet).toEqual([]);
    expect(noted(r.out, `${server.url}/jsmotion?forever`)).toEqual([`snapseq: 02.png taken with DOM still changing after 3 s (most changed: div#x)  ${server.url}/jsmotion?forever`]);
    expect(noted(r.out, `${server.url}/chain`)).toEqual([`snapseq: 03.png taken with 1 image still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/chain`]);
    expect(noted(r.out, `${server.url}/chain?far`)).toEqual([`snapseq: 04.png taken with 1 image still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/chain?far`]);
    expect(noted(r.out, `${server.url}/stall`)).toEqual([`snapseq: 05.png taken with 3 images still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/stall`]);
    expect(r.out.match(/snapseq: \d+\.png taken with/g)).toHaveLength(4);
  });
});

describe("readiness", () => {
  it("waits for a streamed document, only for the images in view, names what it gave up on, restores the scroll, notes an inner scroller and follows scale: css", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 }, deviceScaleFactor: 2 } },
  screenshotsDir: "out",
});
`,
      sequences: {
        // The click resolves once /stream commits, while it is still parsing; 600 ms later the rest arrives.
        "stream.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/tostream");
  await page.click("#go");
  await seq.snap();
});
`,
        "images.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/manylazy");
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t > 3000) throw new Error("snap waited " + (Date.now() - t) + " ms for images out of view");
  await seq.snapPage();
});
`,
        "broken.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/broken");
  await seq.snap();
  await page.evaluate(() => document.images[0].remove());
  await seq.snap();
  await page.evaluate(() => document.images[0].remove());
  await seq.snap();
});
`,
        "scale.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/scale");
  await seq.snap({ scale: "css" });
  await seq.snap();
});
`,
        "scroll.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  const y = () => page.evaluate(() => scrollY);
  await page.goto("/long");
  await page.evaluate(() => scrollTo(0, 1500));
  await seq.snapPage();
  if ((await y()) !== 1500) throw new Error("scrollY " + (await y()) + " after snapPage");
  await page.goto("/scrolly");
  await seq.snapPage();
  await page.goto("/drawer");
  await seq.snapPage();
  await page.goto("/shell");
  await seq.snapPage();
  await page.goto("/appshell");
  await seq.snapPage();
  await page.goto("/lands");
  await seq.snapPage();
  await page.goto("/lateshell");
  await seq.snapPage();
  await page.goto("/containbody");
  await seq.snapPage();
});
`,
        "hidden.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/hidden");
  await seq.snap({ clip: { x: 0, y: 0, width: 100, height: 1000 } });
  await seq.snap({ fullPage: true });
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--max-failures", "0"]);
    expect(r.out).toContain("6 passed");
    expect(r.status, r.out).toBe(0);
    const out = join(p, "out", "run1");
    expect(noted(r.out, `${server.url}/stream`)).toEqual([]);
    // In view nothing is pending; the whole page is 40 images that take ten seconds.
    expect(noted(r.out, `${server.url}/manylazy`)).toEqual([
      expect.stringMatching(new RegExp(`^snapseq: 02\\.png taken with \\d+ images still loading after 5 s \\(first: ${server.url}/slow\\.png\\)  `)),
    ]);
    // The URL loses its credentials, query and hash, and is cut to 80 characters.
    const broken = `3 images failed to load (first: ${server.url}/missing/x.png)`;
    expect(noted(r.out, `${server.url}/broken`)).toEqual([
      `snapseq: 01.png taken with ${broken}  ${server.url}/broken`,
      `snapseq: 02.png taken with 2 images failed to load (first: ${`${server.url}/missing/${"x".repeat(90)}.png`.slice(0, 80)})  ${server.url}/broken`,
      `snapseq: 03.png taken with 1 image failed to load (first: a data: URL)  ${server.url}/broken`,
    ]);
    expect(pngSize(join(out, "scale", "d1", "01.png"))).toEqual([400, 300]);
    expect(pngSize(join(out, "scale", "d1", "02.png"))).toEqual([800, 600]);
    // The scroll position comes back (the sequence checks scrollY); the scroller on screen is noted, the drawer off
    // screen is not.
    for (const quiet of ["/long", "/drawer", "/lands"]) expect(noted(r.out, server.url + quiet), quiet).toEqual([]);
    const inner = (n: number, path: string, el: string) =>
      `snapseq: ${String(n).padStart(2, "0")}.png taken with the page scrolls inside <${el}> not the document: scrollable content may be omitted  ${server.url}${path}`;
    expect(noted(r.out, `${server.url}/scrolly`)).toEqual([inner(2, "/scrolly", "main.content")]);
    expect(noted(r.out, `${server.url}/shell`)).toEqual([inner(4, "/shell", "main.content")]);
    expect(noted(r.out, `${server.url}/appshell`)).toEqual([inner(5, "/appshell", "app-shell div.content")]);
    expect(noted(r.out, `${server.url}/lateshell`)).toEqual([inner(7, "/lateshell", "main.content")]);
    expect(noted(r.out, `${server.url}/containbody`)).toEqual([inner(8, "/containbody", "body")]);
    expect(pngSize(join(out, "scroll", "d1", "04.png"))).toEqual([800, 600]);
    // The data that landed during the wait made it a page: grown to its three screens.
    expect(pngSize(join(out, "scroll", "d1", "06.png"))).toEqual([800, 1800]);
    // In view, only the one at opacity 0 is pending; the full page waits for all three and counts no hidden failure.
    expect(noted(r.out, `${server.url}/hidden`)).toEqual([
      `snapseq: 01.png taken with 1 image still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/hidden`,
      `snapseq: 02.png taken with 3 images still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/hidden`,
    ]);
  });
});

describe("readiness without web fonts", () => {
  const config = () => `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
});
`;

  it("calls a slow image an image wait, not a font wait, while the load event is pending", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "late.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/lateimg", { waitUntil: "domcontentloaded" });
  await seq.snap();
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, []);
    expect(r.status, r.out).toBe(0);
    // fonts.ready waits for the load event, which waits for the image: no font is loading, so no font note.
    expect(noted(r.out, `${server.url}/lateimg`)).toEqual([`snapseq: 01.png taken with 1 image still loading after 5 s (first: ${server.url}/late.png)  ${server.url}/lateimg`]);
  });

  it("puts the readiness notes in the error when the screenshot itself times out on an image that never answers", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "held.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/initstall", { waitUntil: "domcontentloaded" });
  await seq.snap({ timeout: 3000 });
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, []);
    expect(r.status).not.toBe(0);
    // Playwright's screenshot waits for the load event, which this image holds; the notes were never printed before.
    expect(r.out).toMatch(
      new RegExp(`Timeout 3000ms exceeded[\\s\\S]*; readiness: 1 image still loading after 5 s \\(first: ${server.url}/stall\\.png\\)`),
    );
  });

  it("leaves failed.png when an image in the initial HTML never answers, and the note keeps a loader's url parameter, not its signature", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "next.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/initnext", { waitUntil: "domcontentloaded" });
  await seq.snap({ timeout: 2000 });
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, []);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`; readiness: 1 image still loading after 5 s (first: ${server.url}/_next/image?url=/img/hero.png)`);
    expect(r.out).not.toMatch(/sig=|secret/);
    // The page holds its load event, which the teardown's screenshot waits for too: pending images are abandoned first.
    const dir = join(p, "out", "run1", "next", "d1");
    expect(readdirSync(dir).sort()).toEqual(["failed.png"]);
    expect(r.out).toContain(`failed.png  ${server.url}/initnext`);
  });

  it("leaves failed.png when the stalled image is a <picture> source or sits in a frame", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "picture.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/initpicture", { waitUntil: "domcontentloaded" });
  await seq.snap({ timeout: 2000 });
});
`,
        "frame.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/initframe", { waitUntil: "domcontentloaded" });
  await seq.snap({ timeout: 2000 });
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--max-failures", "0"]);
    expect(r.status).not.toBe(0);
    for (const name of ["picture", "frame"]) {
      const dir = join(p, "out", "run1", name, "d1");
      expect(readdirSync(dir).sort(), name).toEqual(["failed.png"]);
      expect(r.out, name).toContain(`failed.png  ${server.url}/init${name}`);
    }
  });

  it("keeps only a safe http(s) image URL from a loader's query in the note: no credentials however they are encoded, no data: URL", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "loader.seq.ts": `
import { sequence } from "snapseq";
const queries = [
  "url=https%253A%252F%252Fuser%3Apassword%40cdn.test%2Fa.png%3Ftok%3D1%23h", // encoded twice, with credentials, a query and a hash
  "url=%20https%3A%2F%2Fuser%3Apassword%40cdn.test%2Fa.png", // a leading space
  "url=DATA%3Aimage%2Fpng%3Bbase64%2CAAAA", // any case
  "url=%0Adata%3Aimage%2Fpng%3Bbase64%2CAAAA", // a newline first
  "w=64&url=%2Fimg%2Fa.png%3Fsig%3Dsecret&image=%2Fb.png", // the first of the three, relative
];
sequence(async ({ page, seq }) => {
  await page.goto("/");
  for (const q of queries) {
    // A 404 answers at once: one image that failed to load, named by the note.
    await page.evaluate((src) => new Promise((done) => {
      const img = new Image();
      img.style.cssText = "display:block;width:20px;height:20px";
      img.addEventListener("error", done);
      img.src = src;
      document.body.replaceChildren(img);
    }), "/missing?" + q);
    await seq.snap();
  }
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, []);
    expect(r.status, r.out).toBe(0);
    const failed = (n: number, first: string) => `snapseq: 0${n}.png taken with 1 image failed to load (first: ${server.url}/missing${first})  ${server.url}/`;
    expect(noted(r.out, `${server.url}/`)).toEqual([
      failed(1, "?url=https://cdn.test/a.png"),
      failed(2, "?url=https://cdn.test/a.png"),
      failed(3, ""),
      failed(4, ""),
      failed(5, "?url=/img/a.png"),
    ]);
  });

  it("snapPage waits for an image the grown page reveals; snap skips one an overflow box cuts out of view, by the containing block", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
});
`,
      sequences: {
        "reveal.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/reveal", { waitUntil: "domcontentloaded" });
  await seq.snapPage();
  // The section the first grow revealed is there, and its image (1.5 s late) had loaded when the shot was taken.
  const late = await page.evaluate(() => { const img = document.getElementById("late"); return !!img && img.complete && img.naturalWidth > 0; });
  if (!late) throw new Error("snapPage returned before the revealed image loaded");
});
`,
        "panel.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/panel");
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t > 3000) throw new Error("snap waited " + (Date.now() - t) + " ms for an image the panel cuts out of view");
  await page.evaluate(() => (document.getElementById("panel").scrollTop = 100));
  await seq.snap();
  await page.goto("/escape");
  await seq.snap();
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--max-failures", "0"]);
    expect(r.out).toContain("2 passed");
    expect(r.status, r.out).toBe(0);
    expect(noted(r.out, `${server.url}/reveal`)).toEqual([]);
    // Scrolled into the panel's view, the stalled image holds the shot to the cap and is noted; of the four that
    // escape or not, the fixed one and the absolute one above its box do.
    expect(noted(r.out, `${server.url}/panel`)).toEqual([`snapseq: 02.png taken with 1 image still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/panel`]);
    expect(noted(r.out, `${server.url}/escape`)).toEqual([`snapseq: 03.png taken with 2 images still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/escape`]);
  });
});

describe("snapPage geometry", () => {
  const config = (extra = "") => `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",${extra}
});
`;

  it.skipIf(!FONT)("waits for a late font before measuring, so the shot is as tall as the page", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "font.seq.ts": `
import { readFileSync } from "node:fs";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);
  await page.goto("/font", { waitUntil: "domcontentloaded" });
  const before = await height();
  const shot = await seq.snapPage();
  const after = await height();
  if (after <= before) throw new Error("fixture: the late font did not change the height, " + before + " -> " + after);
  const png = readFileSync(shot).readUInt32BE(20);
  if (png !== after) throw new Error("the shot is " + png + " px tall, the page " + after);
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  1 shot");
    expect(r.status).toBe(0);
  });

  it("measures a page that got shorter once the viewport grew by its boxes, and keeps the height of one that did not", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "shrink.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/shrink");
  await seq.snapPage();
  await page.goto("/shrink?stay");
  await seq.snapPage();
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  2 shots");
    expect(r.status).toBe(0);
    expect(pngSize(join(p, "out", "run1", "shrink", "d1", "01.png"))).toEqual([400, 3000]); // the spacer went with the grow
    expect(pngSize(join(p, "out", "run1", "shrink", "d1", "02.png"))).toEqual([400, 3220]); // spacer, its margin; not the fixed bar's child
  });

  it("shoots the full height when the box measure reads short: a negative bottom margin, text overflowing its box, and both with a spacer that goes", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      sequences: {
        "edge.seq.ts": `
import { readFileSync } from "node:fs";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  for (const kind of ["neg", "text"]) {
    await page.goto("/edge?" + kind);
    const shot = await seq.snapPage();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const png = readFileSync(shot).readUInt32BE(20);
    if (png !== height) throw new Error(kind + ": the shot is " + png + " px tall, the page " + height);
  }
  await page.goto("/edge?both");
  await seq.snapPage();
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  3 shots");
    expect(r.status).toBe(0);
    expect(pngSize(join(p, "out", "run1", "edge", "d1", "01.png"))).toEqual([400, 3200]);
    expect(pngSize(join(p, "out", "run1", "edge", "d1", "03.png"))).toEqual([400, 3240]); // the height that measured stable
  });

  // stabilize is on by default and freezes vh before the grow; with `stabilize: false` the page is what the grow makes of it.
  it("with stabilize: false, refuses a layout that follows the viewport, restores the viewport, and points at the native full page", async () => {
    const p = makeProject({
      esm: true,
      config: config("\n  stabilize: false,"),
      sequences: {
        "vh.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/vh");
  const before = page.viewportSize();
  let refused = "";
  try { await seq.snapPage(); } catch (e) { refused = String(e); }
  if (!refused.includes("snap({ fullPage: true })")) throw new Error("snapPage did not refuse: " + refused);
  if (page.viewportSize()?.height !== before?.height) throw new Error("viewport not restored");
  await seq.snap({ fullPage: true });
  // The same layout with html { overflow-y: auto }: refused too, not shot as a page that scrolls inside <html>.
  await page.goto("/vh?root");
  refused = "";
  try { await seq.snapPage(); } catch (e) { refused = String(e); }
  if (!refused.includes("snap({ fullPage: true })")) throw new Error("snapPage did not refuse ?root: " + refused);
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  1 shot");
    expect(r.status).toBe(0);
    expect(pngSize(join(p, "out", "run1", "vh", "d1", "01.png"))).toEqual([400, 800]);
  });
});

describe("navigation", () => {
  it("is bounded by navigationTimeout, which an override argument can change", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig(
  {
    envs: { dev: { host: "${server.url}" } },
    devices: { d1: { viewport: { width: 320, height: 200 } } },
    screenshotsDir: "out",
  },
  { use: { navigationTimeout: 1000 } },
);
`,
      sequences: {
        "hang.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => { await page.goto("/hang"); await seq.snap(); });
`,
      },
    });
    dirs.push(p);
    const t = Date.now();
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Timeout 1000ms exceeded");
    expect(Date.now() - t).toBeLessThan(30_000);
  });
});

describe("timeout", () => {
  it("counts from the last shot, and a sequence that dies leaves failed.png beside its shots", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 320, height: 200 } } },
  screenshotsDir: "out",
});
`,
      sequences: {
        // 4.5 s of sequence under a 2.5 s timeout: passes only if each shot moves the deadline.
        "idle.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/idle");
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(1500); await seq.snap(); }
});
`,
        // One shot, then silence longer than the timeout.
        "stuck.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/stuck");
  await seq.snap();
  await page.waitForTimeout(4000);
  await seq.snap();
});
`,
        // Dies on a later page than its last shot.
        "throws.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/throws");
  await seq.snap();
  await page.goto("/throws-next");
  throw new Error("button not found");
});
`,
      },
    });
    dirs.push(p);

    // Our reporter, with Playwright coloring its errors: the timeout line names the configured budget.
    const r = await playwright(p, ["--timeout", "2500", "--max-failures", "0", "--reporter", REPORTER], { FORCE_COLOR: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("1 passed, 1 failed, 1 timedOut");
    expect(r.out).toMatch(/TIME\s+stuck \/ d1\s+1 shot\s+[\d.]+s\s+\/stuck\s+No shot for 2\.5s\./); // where, then why
    expect(r.out).not.toContain("Test timeout of");
    // A pipe gets words, never marks or the waiting line, even with colors forced on.
    expect(r.out).not.toMatch(/[✔✖⠋⠙⠹]|waiting for|\r/);
    expect(r.out).toMatch(/FAIL\s+throws \/ d1\s+1 shot\s+[\d.]+s\s+\/throws-next\s+Error: button not found/); // the page it died on, not the last shot's
    const out = join(p, "out", "run1");
    expect(readdirSync(join(out, "idle", "d1")).sort()).toEqual(["01.png", "02.png", "03.png"]);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["01.png", "failed.png"]);
    expect(readdirSync(join(out, "throws", "d1")).sort()).toEqual(["01.png", "failed.png"]);
    expect(pngSize(join(out, "stuck", "d1", "failed.png"))).toEqual([320, 200]);

    // No timeout stays no timeout: the deadline is never touched.
    const z = await playwright(p, ["stuck\\.seq", "--timeout", "0"]);
    expect(z.status).toBe(0);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["01.png", "02.png"]);
  });
});

describe("replay", () => {
  it("fails without a file, records one with --record, then answers from it without calling the backend", async () => {
    const dir = makeProject({
      esm: true,
      config: `import { defineConfig } from "snapseq";
export default defineConfig({ envs: { dev: { host: ${JSON.stringify(server.url)}, replay: { "**/api": "snapseq/replay/api.json" } } }, devices: { d1: {} } });`,
      sequences: {
        "w.seq.ts": `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/widget");
  await page.locator("#v:not(:empty)").waitFor();
  const v = await page.locator("#v").textContent();
  if (v !== process.env.EXPECT_V) throw new Error("rendered " + v);
  await seq.snap();
});`,
      },
    });
    dirs.push(dir);
    const file = join(dir, "snapseq/replay/api.json");
    const apiHits = () => server.hits.filter((h) => h.url.startsWith("/api")).length;

    const missing = await playwright(dir, [], { EXPECT_V: "live" });
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain("snapseq: no replay file for **/api: snapseq/replay/api.json");
    expect(existsSync(file)).toBe(false);

    let hits = apiHits();
    const rec = await snapseq(dir, ["--record"], { EXPECT_V: "live" });
    expect(rec.status, rec.out).toBe(0);
    expect(apiHits()).toBe(hits + 1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: "live" });

    writeFileSync(file, JSON.stringify({ v: "replayed" }));
    hits = apiHits();
    const rep = await playwright(dir, [], { EXPECT_V: "replayed" });
    expect(rep.status, rep.out).toBe(0);
    expect(apiHits()).toBe(hits);
    expect(existsSync(join(dir, "screenshots/run1/w/d1/01.png"))).toBe(true);
  });
});

describe("run directory", () => {
  it("stamps each run with a Finder-style local-time dir and keeps Playwright's artifacts out of the screenshots dir", async () => {
    const r = await playwright(project, ["a\\.seq", "--project", "d1"], { SNAPSEQ_RUN: "" });
    expect(r.status).toBe(0);
    const out = join(project, "out");
    const runs = readdirSync(out).filter((n) =>
      /^\d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2} [AP]M$/.test(n),
    );
    expect(runs).toHaveLength(1);
    expect(readdirSync(join(out, runs[0]!, "a", "d1")).sort()).toEqual(["01.png", "02.png"]);
    expect(existsSync(join(out, ".playwright"))).toBe(false);
    // Playwright's own folder inside snapseq's cache, which the orchestration's run cache also lives in.
    expect(existsSync(join(project, "node_modules", ".cache", "snapseq", "playwright", ".last-run.json"))).toBe(
      true,
    );
  });
});
