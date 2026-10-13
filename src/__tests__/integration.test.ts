import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the BUILT package through the real Playwright CLI, the way a consumer would.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PW_CLI = join(PKG, "node_modules/@playwright/test/cli.js");
const AUTH = `Basic ${Buffer.from("u:p").toString("base64")}`;
// Smooth scrolling, a running animation and a transition on a <details> fold's pseudo-element,
// so a motion-freezing helper has something to defeat.
const MOTION_PAGE = `<!doctype html><html style="scroll-behavior:smooth"><head><style>
@keyframes spin { to { transform: rotate(1turn) } }
#spin { animation: spin 1s linear infinite; transition: opacity 1s }
#fold::details-content { transition: height 300ms }
</style></head><body style="margin:0"><div id="spin">x</div><details id="fold"><summary>s</summary>b</details><div style="height:900px"></div></body></html>`;
// 960 px tall; grows by 100 px while its bottom slot is in view, the way a tray lands when its slot shows.
const STICKY_PAGE = `<!doctype html><html><head><style>html.landed { padding-bottom: 100px }</style></head>
<body style="margin:0"><div style="height:900px;background:#eee"></div><div id="slot" style="height:60px;background:#cde"></div>
<script>new IntersectionObserver((entries) => document.documentElement.classList.toggle("landed", entries.some((e) => e.isIntersecting))).observe(document.getElementById("slot"));</script>
</body></html>`;

// JS-driven motion: an attribute changes every frame for 40 frames, then data-done. `?forever` never stops.
const JS_MOTION_PAGE = `<!doctype html><html><body style="margin:0"><div id="x">x</div><script>
let n = 0; const el = document.getElementById("x"); const forever = location.search.includes("forever");
const tick = () => { el.setAttribute("data-n", String(++n)); if (forever || n < 40) requestAnimationFrame(tick); else document.documentElement.dataset.done = "1"; };
requestAnimationFrame(tick);
</script></body></html>`;

// A face that lands 1.5 s late, half again as large as the fallback: every line reflows and the page grows.
const FONT = [
  "/System/Library/Fonts/Supplemental/Verdana.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
].find((f) => existsSync(f));
const FONT_PAGE = `<!doctype html><html><head><style>@font-face { font-family: Late; src: url(/slow-font.ttf); size-adjust: 150%; font-display: swap } body { margin: 0; font: 24px Late, Arial }</style></head><body>${"<div>The measured height changes with the font.</div>".repeat(25)}</body></html>`;
// A block as tall as the viewport, then 500 px more: the page grows with every viewport the shot sets.
const VH_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:100vh;background:#cde"></div><div style="height:500px;background:#eee"></div></body></html>`;

// A lazy image 2000 px down whose bytes arrive 1.5 s after they are asked for; 100 px tall once loaded.
const LAZY_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:2000px"></div><img id="lazy" loading="lazy" src="/slow.png" style="display:block;width:100px"></body></html>`;
// Renders one field of a JSON response, so a replayed body shows in the page.
const WIDGET_PAGE = `<!doctype html><html><body><h1 id="v"></h1><script>fetch("/api").then((r) => r.json()).then((j) => { document.getElementById("v").textContent = j.v; });</script></body></html>`;
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

interface Hit {
  url: string;
  ua: string;
  auth?: string;
}

function startServer() {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push({ url, ua: req.headers["user-agent"] ?? "", auth: req.headers.authorization });
    if (url.startsWith("/stall.png") || url.startsWith("/hang")) return; // never answers; the browser close ends it
    if (url.startsWith("/slow-font.ttf")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "font/ttf" });
        res.end(readFileSync(FONT!));
      }, 1500);
      return;
    }
    if (url.startsWith("/slow.png")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_1x1);
      }, 1500);
      return;
    }
    if (url.startsWith("/api")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: "live" }));
      return;
    }
    if (url.startsWith("/protected") && req.headers.authorization !== AUTH) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      url.startsWith("/sticky")
        ? STICKY_PAGE
        : url.startsWith("/widget")
          ? WIDGET_PAGE
        : url.startsWith("/font")
          ? FONT_PAGE
          : url.startsWith("/vh")
            ? VH_PAGE
        : url.startsWith("/lazy")
          ? LAZY_PAGE
          : url.startsWith("/chain")
            ? // Blur-up after the load event: a click inserts a placeholder and a stalled sibling; the
              // placeholder's load inserts the real image, lazy and far below the fold, so only an eager
              // flip starts it. The stalled sibling must not hide it.
              `<!doctype html><html><body style="margin:0"><button id="go">go</button><div style="height:20000px"></div><script>
document.getElementById("go").addEventListener("click", () => {
  const c = new Image(); c.src = "/stall.png?c"; document.body.appendChild(c);
  const a = new Image(); a.src = "/slow.png?a";
  a.addEventListener("load", () => { const b = new Image(); b.id = "b"; b.loading = "lazy"; b.src = "/slow.png?b"; document.body.appendChild(b); });
  document.body.appendChild(a);
});
</script></body></html>`
            : url.startsWith("/stall")
            ? // Three images that never answer, added after load so the document itself is loaded.
              `<!doctype html><html><body><script>addEventListener("load", () => { for (const i of [1, 2, 3]) { const img = new Image(); img.src = "/stall.png?" + i; document.body.appendChild(img); } });</script></body></html>`
            : url.startsWith("/jsmotion")
              ? JS_MOTION_PAGE
              : url.startsWith("/motion")
                ? MOTION_PAGE
                : `<!doctype html><html><body style="margin:0"><h1>${url}</h1><div style="height:900px;background:#eee"></div></body></html>`,
    );
  });
  return new Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))),
      });
    });
  });
}

function makeProject(opts: {
  esm: boolean;
  config: string;
  captures: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "snapseq-it-"));
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(PKG, join(dir, "node_modules", "snapseq"));
  // The consumer's own Playwright; same realpath as the package's, so one runner instance.
  symlinkSync(
    join(PKG, "node_modules", "@playwright", "test"),
    join(dir, "node_modules", "@playwright", "test"),
  );
  if (opts.esm) writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "snapseq.config.ts"), opts.config);
  for (const [rel, src] of Object.entries(opts.captures)) {
    const file = join(dir, "captures", rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, src);
  }
  return dir;
}

// Async on purpose: the fixture HTTP server runs in this process, so a sync
// spawn would block the event loop and every page.goto would hang.
function playwright(dir: string, args: string[], env: Record<string, string> = {}) {
  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SNAPSEQ_")) spawnEnv[k] = v;
  }
  return new Promise<{ status: number | null; out: string }>((ok) => {
    const child = spawn(
      process.execPath,
      [PW_CLI, "test", "-c", join(dir, "snapseq.config.ts"), ...args],
      { cwd: dir, env: { ...spawnEnv, SNAPSEQ_RUN: "run1", ...env } },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => ok({ status, out }));
  });
}

// The snapseq bin, run from `cwd` (defaults to the project dir).
function snapseq(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  cwd: string = dir,
) {
  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SNAPSEQ_")) spawnEnv[k] = v;
  }
  return new Promise<{ status: number | null; out: string }>((ok) => {
    const child = spawn(process.execPath, [join(PKG, "dist", "cli.js"), ...args], {
      cwd,
      env: { ...spawnEnv, SNAPSEQ_RUN: "run1", ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => ok({ status, out }));
  });
}

const REPORTER = join(PKG, "dist", "reporter.js");

function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const captureA = `
import { capture } from "snapseq";
capture(async ({ page, seq, ctx, env, device }) => {
  if (ctx.env !== env || ctx.device !== device || ctx.seq !== seq) throw new Error("ctx mismatch");
  await page.goto("/a?env=" + env + "&device=" + device);
  await seq.snap();
  await seq.snapPage();
});
`;

const captureB = `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/b");
  await seq.snap();
});
`;

// A file-level skip must run before the seq fixture, so the skipped device gets
// no directory at all.
const captureC = `
import { capture, skipIf } from "snapseq";
skipIf(({ device }) => device !== "d1", "d1 only");
capture(async ({ page, seq }) => { await page.goto("/c"); await seq.snap(); });
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
    captures: {
      "a.capture.ts": captureA,
      "nested/b.capture.ts": captureB,
      "c.capture.ts": captureC,
    },
  });
  dirs.push(project);
});

afterAll(async () => {
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("snapseq via the Playwright CLI", () => {
  it("writes numbered screenshots per capture and project, wipes only its own dirs, self-gitignores, and de-headlesses the UA", async () => {
    const out = join(project, "out");
    mkdirSync(join(out, "run1", "a", "d1"), { recursive: true });
    writeFileSync(join(out, "run1", "a", "d1", "999.png"), "stale");
    mkdirSync(join(out, "unrelated", "d1"), { recursive: true });
    writeFileSync(join(out, "unrelated", "d1", "001.png"), "keep");

    const r = await playwright(project, []);
    expect(r.out).toContain("1 skipped");
    expect(r.out).toContain("5 passed");
    expect(r.out).toContain(`001.png  ${server.url}/a?env=dev&device=d1`); // the list reporter's step line
    expect(r.status).toBe(0);

    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["001.png", "002.png", "shots.txt"]);
    expect(readdirSync(join(out, "run1", "a", "d2")).sort()).toEqual(["001.png", "002.png", "shots.txt"]);
    expect(readdirSync(join(out, "run1", "nested", "b", "d1")).sort()).toEqual(["001.png", "shots.txt"]);
    // the skipped device has no dir
    expect(readdirSync(join(out, "run1", "c", "d1")).sort()).toEqual(["001.png", "shots.txt"]);
    expect(existsSync(join(out, "run1", "c", "d2"))).toBe(false);
    expect(existsSync(join(out, "unrelated", "d1", "001.png"))).toBe(true);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("*\n");

    expect(pngSize(join(out, "run1", "a", "d1", "001.png"))).toEqual([400, 300]);
    expect(pngSize(join(out, "run1", "a", "d2", "001.png"))[0]).toBe(500);
    expect(pngSize(join(out, "run1", "a", "d1", "002.png"))[1]).toBeGreaterThan(300);

    const pageHits = server.hits.filter((h) => h.url.startsWith("/a") || h.url.startsWith("/b"));
    expect(pageHits.map((h) => h.url)).toContain("/a?env=dev&device=d1");
    expect(pageHits.length).toBeGreaterThan(0);
    for (const h of pageHits) {
      expect(h.ua).toContain("Chrome/");
      expect(h.ua).not.toContain("Headless");
    }
  });

  // The filter is a regex (Playwright's): the dot is escaped so a temp dir ending in "a" cannot match too.
  it("a file filter re-runs only that capture", async () => {
    const out = join(project, "out");
    writeFileSync(join(out, "run1", "nested", "b", "d1", "stale.png"), "stale");
    const r = await playwright(project, ["a\\.capture", "--project", "d1"]);
    expect(r.out).toContain("1 passed");
    expect(existsSync(join(out, "run1", "nested", "b", "d1", "stale.png"))).toBe(true);
    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["001.png", "002.png", "shots.txt"]);
  });

  it("SNAPSEQ_ENV picks the env and SNAPSEQ_HOST overrides its host", async () => {
    const before = server.hits.length;
    const r = await playwright(project, ["a\\.capture", "--project", "d1"], {
      SNAPSEQ_ENV: "dead",
      SNAPSEQ_HOST: server.url,
    });
    expect(r.status).toBe(0);
    expect(server.hits.slice(before).map((h) => h.url)).toContain("/a?env=dead&device=d1");
  });

  it("rejects an unknown env at config load", async () => {
    const r = await playwright(project, [], { SNAPSEQ_ENV: "nope" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('unknown env "nope"');
  });

  it("rejects --repeat-each", async () => {
    const r = await playwright(project, ["a\\.capture", "--project", "d1", "--repeat-each", "2"]);
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
});
`,
      captures: {
        "p.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    expect(r.out).toContain("1 passed  1 shot  .screenshots/run1");
    expect(r.status).toBe(0);
    expect(existsSync(join(cjs, ".screenshots", "run1", "p", "d1", "001.png"))).toBe(true);
    expect(server.hits.some((h) => h.url === "/protected/x" && h.auth === AUTH)).toBe(true);
    expect(other.hits.map((h) => h.url)).toContain("/protected/i.png");
    expect(other.hits.filter((h) => h.auth)).toEqual([]);
    await other.close();
  });

  it("refuses a run name that leaves the screenshots dir, before anything is wiped", async () => {
    // Where SNAPSEQ_RUN=../outside would put capture a on d1, and wipe.
    const sentinel = join(project, "outside", "a", "d1", "keep.txt");
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "keep");
    const r = await playwright(project, ["a\\.capture", "--project", "d1"], { SNAPSEQ_RUN: "../outside" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('SNAPSEQ_RUN must be a directory name, not a path: "../outside"');
    expect(existsSync(sentinel)).toBe(true);
  });
});

describe("snapseq bin", () => {
  it("translates --env, --host and --device, and finds the config in cwd", async () => {
    const before = server.hits.length;
    const r = await snapseq(project, [
      "a\\.capture",
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
    const r = await snapseq(project, ["a\\.capture", "--device=d1", "--list"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Total: 1 test in 1 file");
  });

  it("prints its own usage for --help", async () => {
    const r = await snapseq(project, ["--help"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("--device <name>");
  });

  it("fails clearly when no config is in cwd", async () => {
    const r = await snapseq(project, [], {}, join(project, "captures"));
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
      captures: {
        "w.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/w"); await seq.snap(); });
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
    expect(existsSync(join(ws, ".screenshots", "run1", "w", "d1", "001.png"))).toBe(true);
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
      config: `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
});
`,
      captures: {
        // Fails unless the CSS applies to the current document AND survives two navigations.
        "motion.capture.ts": `
import { capture, disableTransitions } from "snapseq";
capture(async ({ page, seq }) => {
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
        "sticky.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/sticky");
  const before = page.viewportSize();
  await seq.snap({ fullPage: true }); // 001: Playwright's full page; the slot never comes into view
  await seq.snapPage();               // 002: tall viewport; the slot shows, the page grows by 100 px
  if (page.viewportSize()?.height !== before?.height) throw new Error("viewport not restored");
  await page.waitForFunction(() => !document.documentElement.classList.contains("landed"));
});
`,
        "clip.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/clip");
  await seq.snap({ clip: { x: 0, y: 0, width: 100, height: 50 } });
});
`,
        // Every shot waits for images: the lazy one below the fold is loaded when snapPage returns,
        // and the native full page forces it to start at all.
        "lazy.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  const loaded = () => page.evaluate(() => { const i = document.getElementById("lazy"); return i.complete && i.naturalWidth > 0; });
  await page.goto("/lazy");
  if (await loaded()) throw new Error("fixture: the lazy image loaded eagerly");
  await seq.snapPage();
  if (!(await loaded())) throw new Error("snapPage returned before the lazy image loaded");
  await page.goto("/lazy?2");
  await seq.snap({ fullPage: true });
  if (!(await loaded())) throw new Error("fullPage returned before the lazy image loaded");
  await page.goto("/chain");
  await page.getByRole("button", { name: "go" }).click();
  await seq.snap();
  if (!(await page.evaluate(() => { const b = document.getElementById("b"); return !!b && b.complete && b.naturalWidth > 0; }))) throw new Error("snap returned before the chained lazy image loaded");
  await page.goto("/stall"); // three images that never answer
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t > 8000) throw new Error("stalled images were waited for one by one");
});
`,
        // snap waits for a quiet DOM: the shot lands after the 40-frame loop, and the 3 s cap releases it on a page that never quiets.
        "settle.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    expect(r.out).toContain("5 passed  10 shots  out/run1");

    const out = join(p, "out", "run1");
    expect(existsSync(join(out, "motion", "d1", "001.png"))).toBe(true);
    expect(pngSize(join(out, "sticky", "d1", "001.png"))).toEqual([400, 960]); // native: not landed
    expect(pngSize(join(out, "sticky", "d1", "002.png"))).toEqual([400, 1060]); // snapPage: landed, re-measured
    expect(pngSize(join(out, "clip", "d1", "001.png"))).toEqual([100, 50]);
    // the lazy image loaded before the height was measured: 2000 px of page plus the 100 px image
    expect(pngSize(join(out, "lazy", "d1", "001.png"))).toEqual([400, 2100]);
    expect(pngSize(join(out, "lazy", "d1", "002.png"))).toEqual([400, 2100]);
    expect(readFileSync(join(out, "clip", "d1", "shots.txt"), "utf8")).toBe(`001.png  ${server.url}/clip\n`);
    // A cap that released a wait is on the shot's line and in the terminal; a shot that was ready says nothing.
    const shots = (name: string) => readFileSync(join(out, name, "d1", "shots.txt"), "utf8");
    expect(shots("settle")).toBe(
      `001.png  ${server.url}/jsmotion\n002.png  ${server.url}/jsmotion?forever  DOM still changing after 3 s\n`,
    );
    expect(shots("lazy")).toBe(
      `001.png  ${server.url}/lazy\n002.png  ${server.url}/lazy?2\n003.png  ${server.url}/chain  1 image still loading after 5 s\n004.png  ${server.url}/stall  3 images still loading after 5 s\n`,
    );
    expect(r.out).toContain(`snapseq: 004.png taken with  3 images still loading after 5 s  ${server.url}/stall`);
    expect(r.out.match(/snapseq: \d{3}\.png taken with/g)).toHaveLength(3);
  });
});

describe("snapPage geometry", () => {
  const config = () => `
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
});
`;

  it.skipIf(!FONT)("waits for a late font before measuring, so the shot is as tall as the page", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      captures: {
        "font.capture.ts": `
import { readFileSync } from "node:fs";
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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

  it("refuses a layout that follows the viewport, restores the viewport, and points at the native full page", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      captures: {
        "vh.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/vh");
  const before = page.viewportSize();
  let refused = "";
  try { await seq.snapPage(); } catch (e) { refused = String(e); }
  if (!refused.includes("snap({ fullPage: true })")) throw new Error("snapPage did not refuse: " + refused);
  if (page.viewportSize()?.height !== before?.height) throw new Error("viewport not restored");
  await seq.snap({ fullPage: true });
});
`,
      },
    });
    dirs.push(p);
    const r = await playwright(p, ["--reporter", REPORTER]);
    expect(r.out).toContain("1 passed  1 shot");
    expect(r.status).toBe(0);
    expect(pngSize(join(p, "out", "run1", "vh", "d1", "001.png"))).toEqual([400, 800]);
    expect(readFileSync(join(p, "out", "run1", "vh", "d1", "shots.txt"), "utf8")).toBe(`001.png  ${server.url}/vh\n`);
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
      captures: {
        "hang.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/hang"); await seq.snap(); });
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
  it("counts from the last shot, and a capture that dies leaves failed.png beside its shots", async () => {
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
      captures: {
        // 4.5 s of capture under a 2.5 s timeout: passes only if each shot moves the deadline.
        "idle.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/idle");
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(1500); await seq.snap(); }
});
`,
        // One shot, then silence longer than the timeout.
        "stuck.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/stuck");
  await seq.snap();
  await page.waitForTimeout(4000);
  await seq.snap();
});
`,
        // Dies on a later page than its last shot.
        "throws.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    expect(readdirSync(join(out, "idle", "d1")).sort()).toEqual(["001.png", "002.png", "003.png", "shots.txt"]);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["001.png", "failed.png", "shots.txt"]);
    expect(readdirSync(join(out, "throws", "d1")).sort()).toEqual(["001.png", "failed.png", "shots.txt"]);
    expect(pngSize(join(out, "stuck", "d1", "failed.png"))).toEqual([320, 200]);
    expect(readFileSync(join(out, "throws", "d1", "shots.txt"), "utf8")).toBe(
      `001.png  ${server.url}/throws\nfailed.png  ${server.url}/throws-next\n`,
    );

    // No timeout stays no timeout: the deadline is never touched.
    const z = await playwright(p, ["stuck\\.capture", "--timeout", "0"]);
    expect(z.status).toBe(0);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["001.png", "002.png", "shots.txt"]);
  });
});

describe("replay", () => {
  it("fails without a file, records one with --record, then answers from it without calling the backend", async () => {
    const dir = makeProject({
      esm: true,
      config: `import { defineConfig } from "snapseq";
export default defineConfig({ envs: { dev: { host: ${JSON.stringify(server.url)}, replay: { "**/api": "captures/replay/api.json" } } }, devices: { d1: {} } });`,
      captures: {
        "w.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/widget");
  await page.locator("#v:not(:empty)").waitFor();
  const v = await page.locator("#v").textContent();
  if (v !== process.env.EXPECT_V) throw new Error("rendered " + v);
  await seq.snap();
});`,
      },
    });
    dirs.push(dir);
    const file = join(dir, "captures/replay/api.json");
    const apiHits = () => server.hits.filter((h) => h.url.startsWith("/api")).length;

    const missing = await playwright(dir, [], { EXPECT_V: "live" });
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain("snapseq: no replay file for **/api: captures/replay/api.json");
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
    expect(existsSync(join(dir, ".screenshots/run1/w/d1/001.png"))).toBe(true);
  });
});

describe("run directory", () => {
  it("stamps each run with a Finder-style local-time dir and keeps Playwright's artifacts out of the screenshots dir", async () => {
    const r = await playwright(project, ["a\\.capture", "--project", "d1"], { SNAPSEQ_RUN: "" });
    expect(r.status).toBe(0);
    const out = join(project, "out");
    const runs = readdirSync(out).filter((n) =>
      /^\d{4}-\d{2}-\d{2} at \d{1,2}\.\d{2}\.\d{2} [AP]M$/.test(n),
    );
    expect(runs).toHaveLength(1);
    expect(readdirSync(join(out, runs[0]!, "a", "d1")).sort()).toEqual(["001.png", "002.png", "shots.txt"]);
    expect(existsSync(join(out, ".playwright"))).toBe(false);
    expect(existsSync(join(project, "node_modules", ".cache", "snapseq", ".last-run.json"))).toBe(
      true,
    );
  });
});
