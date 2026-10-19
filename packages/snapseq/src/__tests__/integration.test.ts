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
import { PDFDocument } from "@cantoo/pdf-lib";
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
  let release: (() => void) | undefined; // answers the /held.png in waiting
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push({ url, ua: req.headers["user-agent"] ?? "", auth: req.headers.authorization });
    if (url.startsWith("/stall.png") || url.startsWith("/hang") || url.startsWith("/_next/image")) return; // never answers; the browser close ends it
    if (url.startsWith("/held.png")) {
      release = () => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_1x1);
      };
      return;
    }
    if (url.startsWith("/release")) {
      release?.();
      release = undefined;
      res.writeHead(204);
      res.end();
      return;
    }
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
    if (url.startsWith("/late.png")) {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_1x1);
      }, 8000);
      return;
    }
    if (url.startsWith("/missing")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.startsWith("/stream")) {
      // 2 KB, then 600 ms of nothing, then the rest: the parser waits mid-document.
      res.writeHead(200, { "content-type": "text/html" });
      res.write(`<!doctype html><html><body style="margin:0"><p>${"x ".repeat(1024)}</p>`);
      setTimeout(() => res.end(`<div id="late" style="height:900px"></div></body></html>`), 600);
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
            ? // ?root: the document's own scroller set to scroll, which is the viewport's, not an inner one.
              url.includes("root") ? VH_PAGE.replace("<html>", '<html style="overflow-y:auto">') : VH_PAGE
        : url.startsWith("/lazy")
          ? LAZY_PAGE
          : url.startsWith("/chain")
            ? // Blur-up after the load event: a click inserts a placeholder and a stalled sibling, in view;
              // the placeholder's load inserts the real image, lazy, so only a rescan finds it. The stalled
              // sibling must not hide it. ?far puts them 20000 px down, where only an eager flip starts the lazy one.
              `<!doctype html><html><body style="margin:0"><button id="go">go</button>${url.includes("far") ? `<div style="height:20000px"></div>` : ""}<script>
document.getElementById("go").addEventListener("click", () => {
  const c = new Image(); c.src = "/stall.png?c"; document.body.appendChild(c);
  const a = new Image(); a.src = "/slow.png?a";
  a.addEventListener("load", () => { const b = new Image(); b.id = "b"; b.loading = "lazy"; b.src = "/slow.png?b"; document.body.appendChild(b); });
  document.body.appendChild(a);
});
</script></body></html>`
            : url.startsWith("/lateimg")
            ? // No web fonts, and one image in the initial HTML that answers after 8 s: the load event waits for it.
              `<!doctype html><html><body style="margin:0"><img src="/late.png" style="display:block;width:100px;height:50px"></body></html>`
            : url.startsWith("/initstall")
            ? // An image in the initial HTML that never answers: the load event never comes.
              `<!doctype html><html><body style="margin:0"><img src="/stall.png?init" style="display:block;width:100px;height:50px"></body></html>`
            : url.startsWith("/initpicture")
            ? // A stalled image chosen by a <source>: removing the <img>'s own attributes would not stop it.
              `<!doctype html><html><body style="margin:0"><picture><source srcset="/stall.png?source"><img src="/stall.png?fallback" style="display:block;width:100px;height:50px"></picture></body></html>`
            : url.startsWith("/initframe")
            ? // The stalled image is in a frame: the parent's load event waits for it too.
              `<!doctype html><html><body style="margin:0"><iframe src="/initstall" style="width:200px;height:100px"></iframe></body></html>`
            : url.startsWith("/initnext")
            ? // The same through an image loader: every image is /_next/image?url=…, signed.
              `<!doctype html><html><body style="margin:0"><img src="/_next/image?url=%2Fimg%2Fhero.png&w=640&sig=secret" style="display:block;width:100px;height:50px"></body></html>`
            : url.startsWith("/stall")
            ? // Three images that never answer, added after load so the document itself is loaded.
              `<!doctype html><html><body><script>addEventListener("load", () => { for (const i of [1, 2, 3]) { const img = new Image(); img.src = "/stall.png?" + i; document.body.appendChild(img); } });</script></body></html>`
            : url.startsWith("/tostream")
              ? `<!doctype html><html><body><a id="go" href="/stream">go</a>`
            : url.startsWith("/manylazy")
              ? // 40 lazy images below the fold, each 1.5 s late; six connections take ten seconds for them all.
                `<!doctype html><html><body style="margin:0"><div style="height:2000px"></div>${Array.from({ length: 40 }, (_, i) => `<img loading="lazy" src="/slow.png?${i}" style="display:block;width:10px;height:10px">`).join("")}</body></html>`
            : url.startsWith("/broken")
              ? `<!doctype html><html><body><img src="http://u:p@${req.headers.host}/missing/x.png?q=1#f"><img src="/missing/${"x".repeat(90)}.png?q=1#h"><img src="data:image/png;base64,AAAA"></body></html>`
            : url.startsWith("/hidden")
              ? // In view at opacity 0 (it may fade in once loaded): waited for. Hidden, or below the viewport under a clip
                // past it: not. A display: none pixel that fails is no broken image, on a full page either. The stalled
                // ones come after the load event, which they would otherwise hold (and fonts.ready with it).
                `<!doctype html><html><body style="margin:0"><img style="display:none" src="/missing/pixel.gif"><div style="height:500px"></div><script>
addEventListener("load", () => {
  for (const [style, q] of [["visibility:hidden", "v"], ["opacity:0", "o"]]) { const img = new Image(); img.style.cssText = style; img.src = "/stall.png?" + q; document.body.prepend(img); }
  const below = new Image(); below.src = "/stall.png?below"; document.body.append(below);
});
</script></body></html>`
            : url.startsWith("/drawer")
              ? // One screen, and a full-height menu that scrolls, off screen to the left.
                `<!doctype html><html><body style="margin:0"><p>one screen</p><nav style="position:fixed;top:0;left:0;width:300px;height:100%;transform:translateX(-100%);overflow-y:auto"><div style="height:3000px"></div></nav></body></html>`
            : url.startsWith("/scrolly")
              ? // One screen to the document; the content scrolls inside main.
                `<!doctype html><html style="height:100%;overflow:hidden"><body style="height:100%;margin:0;overflow:hidden"><main class="content" style="height:100%;overflow-y:auto"><div style="height:3000px"></div></main></body></html>`
            : url.startsWith("/shell")
              ? // The same with body's default 8 px margin: the document is 16 px more than a screen, and grows with the viewport.
                `<!doctype html><html style="height:100%;overflow:hidden"><body style="height:100%;overflow:hidden"><main class="content" style="height:100%;overflow-y:auto"><div style="height:3000px"></div></main></body></html>`
            : url.startsWith("/appshell")
              ? // The scroller inside an open shadow root.
                `<!doctype html><html style="height:100%;overflow:hidden"><body style="height:100%;margin:0;overflow:hidden"><app-shell style="display:block;height:100%"></app-shell><script>document.querySelector("app-shell").attachShadow({ mode: "open" }).innerHTML = '<div class="content" style="height:100%;overflow-y:auto"><div style="height:3000px"></div></div>';</script></body></html>`
            : url.startsWith("/lands")
              ? // One screen with a scroller, until the data lands 500 ms on (a ticking skeleton until then): three screens.
                `<!doctype html><html><body style="margin:0"><main style="height:300px;overflow-y:auto"><div style="height:3000px"></div></main><script>
const tick = setInterval(() => (document.body.dataset.t = String(performance.now())), 50);
setTimeout(() => { clearInterval(tick); const d = document.createElement("div"); d.style.height = "600px"; document.body.append(d); }, 500);
</script></body></html>`
            : url.startsWith("/lateshell")
              ? // The body-margin shell, its scroller filled 500 ms on: no scroller yet when the shot starts.
                `<!doctype html><html style="height:100%;overflow:hidden"><body style="height:100%;overflow:hidden"><main class="content" style="height:100%;overflow-y:auto"></main><script>
const tick = setInterval(() => (document.body.dataset.t = String(performance.now())), 50);
setTimeout(() => { clearInterval(tick); document.querySelector("main").innerHTML = '<div style="height:3000px"></div>'; }, 500);
</script></body></html>`
            : url.startsWith("/reveal")
              ? // An image at the top, held until the first resize (snapPage's first grow), whose load adds a section
                // below the grown viewport; the section's image gets its URL from an IntersectionObserver once the
                // section shows, and answers 1.5 s later. window.resizes counts the grows.
                `<!doctype html><html><body style="margin:0"><img src="/held.png" style="display:block;width:100px"><div style="height:900px"></div><script>
window.resizes = 0;
addEventListener("resize", () => { if (++window.resizes === 1) fetch("/release"); });
document.images[0].addEventListener("load", () => {
  const s = document.createElement("section"); s.style.height = "200px";
  s.innerHTML = '<img id="late" data-src="/slow.png?late" style="display:block;width:10px;height:10px">';
  document.body.append(s);
  new IntersectionObserver((entries, o) => { if (entries.some((e) => e.isIntersecting)) { o.disconnect(); const img = document.getElementById("late"); img.src = img.dataset.src; } }).observe(s);
});
</script></body></html>`
            : url.startsWith("/panel")
              ? // A 100 px panel that scrolls; after load, an image that never answers goes 150 px down its content:
                // in the viewport, below the panel's visible area.
                `<!doctype html><html><body style="margin:0"><div id="panel" style="height:100px;overflow-y:auto"><div style="height:150px"></div><div id="slot"></div><div style="height:300px"></div></div><script>
addEventListener("load", () => { const img = new Image(); img.src = "/stall.png?panel"; img.style.cssText = "display:block;width:10px;height:10px"; document.getElementById("slot").append(img); });
</script></body></html>`
            : url.startsWith("/escape")
              ? // Four images that never answer, in view, each outside an overflow: hidden box (added after load).
                // f: fixed, so its box clips nothing of it. a: absolute, its containing block the positioned card
                // above the unpositioned box, so shown. p: absolute in a positioned box, cut out. o: inside two
                // nested boxes it overlaps one at a time, with no pixel in both, cut out.
                `<!doctype html><html><body style="margin:0">
<div id="f" style="overflow:hidden;height:40px"></div>
<div style="position:relative;height:100px"><div id="a" style="overflow:hidden;height:40px"></div></div>
<div id="p" style="position:relative;overflow:hidden;height:40px"></div>
<div style="overflow:hidden;width:100px;height:40px"><div id="o" style="overflow:hidden;width:100px;height:40px;margin-left:150px"></div></div>
<script>
addEventListener("load", () => {
  for (const [slot, css] of [["f", "position:fixed;top:270px;left:300px"], ["a", "position:absolute;top:60px"], ["p", "position:absolute;top:60px"], ["o", "width:150px;margin-left:-100px"]]) {
    const img = new Image(); img.src = "/stall.png?" + slot; img.style.cssText = "display:block;width:10px;height:10px;" + css; document.getElementById(slot).append(img);
  }
});
</script></body></html>`
            : url.startsWith("/containbody")
              ? // html visible, body with paint containment: body's overflow stays its own, so body scrolls inside.
                `<!doctype html><html style="height:100%"><body style="height:100%;margin:0;overflow-y:auto;contain:paint"><div style="height:3000px"></div></body></html>`
            : url.startsWith("/long")
              ? `<!doctype html><html><body style="margin:0"><div style="height:3000px"></div></body></html>`
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
  // The workspace's plugins, built by their own prepare/test scripts.
  for (const name of ["label", "pdf"]) {
    symlinkSync(resolve(PKG, "..", name), join(dir, "node_modules", `snapseq-${name}`));
  }
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

// Page sizes in pt. pdf-lib writes compressed object streams, so a grep for MediaBox sees nothing.
const pdfPages = async (file: string) =>
  (await PDFDocument.load(readFileSync(file))).getPages().map((p) => [p.getWidth(), p.getHeight()]);

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
    writeFileSync(join(out, "unrelated", "d1", "01.png"), "keep");

    const r = await playwright(project, []);
    expect(r.out).toContain("1 skipped");
    expect(r.out).toContain("5 passed");
    expect(r.out).toContain(`01.png  ${server.url}/a?env=dev&device=d1`); // the list reporter's step line
    expect(r.status).toBe(0);

    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
    expect(readdirSync(join(out, "run1", "a", "d2")).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
    expect(readdirSync(join(out, "run1", "nested", "b", "d1")).sort()).toEqual(["01.png", "shots.txt"]);
    // the skipped device has no dir
    expect(readdirSync(join(out, "run1", "c", "d1")).sort()).toEqual(["01.png", "shots.txt"]);
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
  it("a file filter re-runs only that capture", async () => {
    const out = join(project, "out");
    writeFileSync(join(out, "run1", "nested", "b", "d1", "stale.png"), "stale");
    const r = await playwright(project, ["a\\.capture", "--project", "d1"]);
    expect(r.out).toContain("1 passed");
    expect(existsSync(join(out, "run1", "nested", "b", "d1", "stale.png"))).toBe(true);
    expect(readdirSync(join(out, "run1", "a", "d1")).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
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
  format: { type: "jpeg", quality: 50 },
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
    const shot = readFileSync(join(cjs, ".screenshots", "run1", "p", "d1", "01.jpg"));
    expect([...shot.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // a JPEG, by its magic bytes
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

  it("refuses to wipe a capture's directory that holds another capture's output, and deletes nothing", async () => {
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
      captures: { "home.capture.ts": captureB },
    });
    dirs.push(p);
    // What home/d1.capture.ts on d2 writes: inside home.capture.ts's directory on d1.
    const theirs = join(p, "out", "run1", "home", "d1", "d2", "01.png");
    const mine = join(p, "out", "run1", "home", "d1", "01.png");
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, "keep");
    writeFileSync(join(dirname(theirs), "shots.txt"), "01.png  http://x/\n");
    writeFileSync(mine, "stale");
    const r = await playwright(p, ["--project", "d1"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`${join("home", "d1")}: it holds another capture's output (d2); rename one of the captures`);
    expect(readFileSync(theirs, "utf8")).toBe("keep");
    expect(readFileSync(mine, "utf8")).toBe("stale");
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
    expect(existsSync(join(ws, ".screenshots", "run1", "w", "d1", "01.png"))).toBe(true);
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
    expect(r.out).toContain("5 passed  11 shots  out/run1");

    const out = join(p, "out", "run1");
    expect(existsSync(join(out, "motion", "d1", "01.png"))).toBe(true);
    expect(pngSize(join(out, "sticky", "d1", "01.png"))).toEqual([400, 960]); // native: not landed
    expect(pngSize(join(out, "sticky", "d1", "02.png"))).toEqual([400, 1060]); // snapPage: landed, re-measured
    expect(pngSize(join(out, "clip", "d1", "01.png"))).toEqual([100, 50]);
    // the lazy image loaded before the height was measured: 2000 px of page plus the 100 px image
    expect(pngSize(join(out, "lazy", "d1", "01.png"))).toEqual([400, 2100]);
    expect(pngSize(join(out, "lazy", "d1", "02.png"))).toEqual([400, 2100]);
    expect(readFileSync(join(out, "clip", "d1", "shots.txt"), "utf8")).toBe(`01.png  ${server.url}/clip\n`);
    // A cap that released a wait is on the shot's line and in the terminal; a shot that was ready says nothing.
    const shots = (name: string) => readFileSync(join(out, name, "d1", "shots.txt"), "utf8");
    expect(shots("settle")).toBe(
      `01.png  ${server.url}/jsmotion\n02.png  ${server.url}/jsmotion?forever  DOM still changing after 3 s (most changed: div#x)\n`,
    );
    expect(shots("lazy")).toBe(
      `01.png  ${server.url}/lazy\n02.png  ${server.url}/lazy?2\n` +
        `03.png  ${server.url}/chain  1 image still loading after 5 s (first: ${server.url}/stall.png)\n` +
        `04.png  ${server.url}/chain?far  1 image still loading after 5 s (first: ${server.url}/stall.png)\n` +
        `05.png  ${server.url}/stall  3 images still loading after 5 s (first: ${server.url}/stall.png)\n`,
    );
    expect(r.out).toContain(`snapseq: 05.png taken with 3 images still loading after 5 s (first: ${server.url}/stall.png)  ${server.url}/stall`);
    expect(r.out.match(/snapseq: \d+\.png taken with/g)).toHaveLength(4);
  });
});

describe("readiness", () => {
  it("waits for a streamed document, only for the images in view, names what it gave up on, restores the scroll, notes an inner scroller, lists hook notes and follows scale: css", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 }, deviceScaleFactor: 2 } },
  screenshotsDir: "out",
  plugins: [
    {
      name: "probe",
      beforeSnap: async (shot, ctx) => {
        const state = await ctx.page.evaluate(() => document.readyState + " " + !!document.getElementById("late"));
        appendFileSync(join(ctx.seq.dir, "before.txt"), state + "\\n");
        // The second note is the first once cleaned, so it is listed once.
        if (shot.options.note) shot.notes.push(shot.options.note, "from\\nhook ");
        if (shot.options.cssByHook) shot.options.scale = "css";
      },
      afterSnap: async (shot, ctx) => {
        appendFileSync(join(ctx.seq.dir, "probe.txt"), JSON.stringify([shot.name, shot.deviceScaleFactor, shot.notes]) + "\\n");
        shot.notes.push("from afterSnap"); // too late for the line
        // Between the scroll position's save and its restore: the same document under another URL, or a new one.
        if (shot.options.hash) await ctx.page.evaluate(() => history.replaceState(null, "", "#x"));
        if (shot.options.reload) await ctx.page.reload();
      },
    },
  ],
});
`,
      captures: {
        // The click resolves once /stream commits, while it is still parsing; 600 ms later the rest arrives.
        "stream.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/tostream");
  await page.click("#go");
  await seq.snap();
});
`,
        "images.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/manylazy");
  const t = Date.now();
  await seq.snap();
  if (Date.now() - t > 3000) throw new Error("snap waited " + (Date.now() - t) + " ms for images out of view");
  await seq.snapPage();
});
`,
        "broken.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/broken");
  await seq.snap({ note: "from hook" });
  await page.evaluate(() => document.images[0].remove());
  await seq.snap();
  await page.evaluate(() => document.images[0].remove());
  await seq.snap();
});
`,
        "scale.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/scale");
  await seq.snap({ scale: "css" });
  await seq.snap();
  await seq.snap({ cssByHook: true }); // decided at the screenshot, after the hooks
});
`,
        "scroll.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  const y = () => page.evaluate(() => scrollY);
  await page.goto("/long");
  await page.evaluate(() => scrollTo(0, 1500));
  await seq.snapPage();
  if ((await y()) !== 1500) throw new Error("scrollY " + (await y()) + " after snapPage");
  await seq.snapPage({ hash: true });
  if ((await y()) !== 1500) throw new Error("scrollY " + (await y()) + " after a replaceState");
  await seq.snapPage({ reload: true });
  if ((await y()) !== 0) throw new Error("scrollY " + (await y()) + " after a reload");
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
        "hidden.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    const shots = (name: string) => readFileSync(join(out, name, "d1", "shots.txt"), "utf8");
    expect(shots("stream")).toBe(`01.png  ${server.url}/stream\n`);
    // The hooks run on the parsed document. (The shot itself waited already: fonts.ready holds until the document loads.)
    expect(readFileSync(join(out, "stream", "d1", "before.txt"), "utf8")).toMatch(/^(interactive|complete) true\n$/);
    // In view nothing is pending; the whole page is 40 images that take ten seconds.
    expect(shots("images")).toMatch(
      new RegExp(`^01\\.png  ${server.url}/manylazy\\n02\\.png  ${server.url}/manylazy  \\d+ images still loading after 5 s \\(first: ${server.url}/slow\\.png\\)\\n$`),
    );
    // Hook notes first, cleaned and listed once, then the readiness notes. The URL loses its credentials, query and
    // hash, and is cut to 80 characters.
    const broken = `3 images failed to load (first: ${server.url}/missing/x.png)`;
    expect(shots("broken")).toBe(
      `01.png  ${server.url}/broken  from hook, ${broken}\n` +
        `02.png  ${server.url}/broken  2 images failed to load (first: ${`${server.url}/missing/${"x".repeat(90)}.png`.slice(0, 80)})\n` +
        `03.png  ${server.url}/broken  1 image failed to load (first: a data: URL)\n`,
    );
    expect(r.out).toContain(`snapseq: 01.png taken with from hook, ${broken}  ${server.url}/broken`);
    // afterSnap sees the merged notes; what it pushes stays off the line.
    const probed = (name: string) => readFileSync(join(out, name, "d1", "probe.txt"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(probed("broken")[0]).toEqual(["01.png", 2, ["from hook", broken]]);
    expect(probed("scale")).toEqual([["01.png", 1, []], ["02.png", 2, []], ["03.png", 1, []]]);
    expect(pngSize(join(out, "scale", "d1", "01.png"))).toEqual([400, 300]);
    expect(pngSize(join(out, "scale", "d1", "02.png"))).toEqual([800, 600]);
    expect(pngSize(join(out, "scale", "d1", "03.png"))).toEqual([400, 300]);
    // Restored after a replaceState, not after a reload (the capture checks scrollY); the scroller on screen is
    // noted, the drawer off screen is not.
    expect(shots("scroll")).toBe(
      `01.png  ${server.url}/long\n02.png  ${server.url}/long\n03.png  ${server.url}/long#x\n` +
        `04.png  ${server.url}/scrolly  the page scrolls inside <main.content> not the document: scrollable content may be omitted\n` +
        `05.png  ${server.url}/drawer\n` +
        `06.png  ${server.url}/shell  the page scrolls inside <main.content> not the document: scrollable content may be omitted\n` +
        `07.png  ${server.url}/appshell  the page scrolls inside <app-shell div.content> not the document: scrollable content may be omitted\n` +
        `08.png  ${server.url}/lands\n` +
        `09.png  ${server.url}/lateshell  the page scrolls inside <main.content> not the document: scrollable content may be omitted\n` +
        `10.png  ${server.url}/containbody  the page scrolls inside <body> not the document: scrollable content may be omitted\n`,
    );
    // Not refused, and not grown: the device's viewport, at 2x.
    expect(pngSize(join(out, "scroll", "d1", "06.png"))).toEqual([800, 600]);
    // The data that landed during the wait made it a page: grown to its three screens.
    expect(pngSize(join(out, "scroll", "d1", "08.png"))).toEqual([800, 1800]);
    // In view, only the one at opacity 0 is pending; the full page waits for all three and counts no hidden failure.
    expect(shots("hidden")).toBe(
      `01.png  ${server.url}/hidden  1 image still loading after 5 s (first: ${server.url}/stall.png)\n` +
        `02.png  ${server.url}/hidden  3 images still loading after 5 s (first: ${server.url}/stall.png)\n`,
    );
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
      captures: {
        "late.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    expect(readFileSync(join(p, "out", "run1", "late", "d1", "shots.txt"), "utf8")).toBe(
      `01.png  ${server.url}/lateimg  1 image still loading after 5 s (first: ${server.url}/late.png)\n`,
    );
  });

  it("puts the readiness notes in the error when the screenshot itself times out on an image that never answers", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      captures: {
        "held.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
      captures: {
        "next.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    expect(readdirSync(dir).sort()).toEqual(["failed.png", "shots.txt"]);
    expect(readFileSync(join(dir, "shots.txt"), "utf8")).toBe(`failed.png  ${server.url}/initnext\n`);
  });

  it("leaves failed.png when the stalled image is a <picture> source or sits in a frame", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      captures: {
        "picture.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/initpicture", { waitUntil: "domcontentloaded" });
  await seq.snap({ timeout: 2000 });
});
`,
        "frame.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
      expect(readdirSync(dir).sort(), name).toEqual(["failed.png", "shots.txt"]);
      expect(readFileSync(join(dir, "shots.txt"), "utf8"), name).toBe(`failed.png  ${server.url}/init${name}\n`);
    }
  });

  it("keeps only a safe http(s) image URL from a loader's query in the note: no credentials however they are encoded, no data: URL", async () => {
    const p = makeProject({
      esm: true,
      config: config(),
      captures: {
        "loader.capture.ts": `
import { capture } from "snapseq";
const queries = [
  "url=https%253A%252F%252Fuser%3Apassword%40cdn.test%2Fa.png%3Ftok%3D1%23h", // encoded twice, with credentials, a query and a hash
  "url=%20https%3A%2F%2Fuser%3Apassword%40cdn.test%2Fa.png", // a leading space
  "url=DATA%3Aimage%2Fpng%3Bbase64%2CAAAA", // any case
  "url=%0Adata%3Aimage%2Fpng%3Bbase64%2CAAAA", // a newline first
  "w=64&url=%2Fimg%2Fa.png%3Fsig%3Dsecret&image=%2Fb.png", // the first of the three, relative
];
capture(async ({ page, seq }) => {
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
    const failed = (first: string) => `  1 image failed to load (first: ${server.url}/missing${first})\n`;
    expect(readFileSync(join(p, "out", "run1", "loader", "d1", "shots.txt"), "utf8")).toBe(
      `01.png  ${server.url}/${failed("?url=https://cdn.test/a.png")}` +
        `02.png  ${server.url}/${failed("?url=https://cdn.test/a.png")}` +
        `03.png  ${server.url}/${failed("")}` +
        `04.png  ${server.url}/${failed("")}` +
        `05.png  ${server.url}/${failed("?url=/img/a.png")}`,
    );
  });

  it("snapPage waits for an image the grown page reveals; snap skips one an overflow box cuts out of view, by the containing block", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "snapseq";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 400, height: 300 } } },
  screenshotsDir: "out",
  plugins: [
    {
      name: "probe",
      // Right after the screenshot, the viewport still grown: the revealed image as the shot found it, and the grows.
      afterSnap: async (_shot, ctx) => {
        const late = await ctx.page.evaluate(() => {
          const img = document.getElementById("late");
          return img && [img.complete && img.naturalWidth > 0, window.resizes];
        });
        if (late) appendFileSync(join(ctx.seq.dir, "probe.txt"), JSON.stringify(late) + "\\n");
      },
    },
  ],
});
`,
      captures: {
        "reveal.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  await page.goto("/reveal", { waitUntil: "domcontentloaded" });
  await seq.snapPage();
});
`,
        "panel.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
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
    const shots = (name: string) => readFileSync(join(p, "out", "run1", name, "d1", "shots.txt"), "utf8");
    expect(shots("reveal")).toBe(`01.png  ${server.url}/reveal\n`);
    // Loaded at the shot, which came after the second grow (the first was held until the first resize).
    expect(readFileSync(join(p, "out", "run1", "reveal", "d1", "probe.txt"), "utf8")).toBe("[true,2]\n");
    // Scrolled into the panel's view, the stalled image holds the shot to the cap and is noted; of the four that
    // escape or not, the fixed one and the absolute one above its box do.
    expect(shots("panel")).toBe(
      `01.png  ${server.url}/panel\n02.png  ${server.url}/panel  1 image still loading after 5 s (first: ${server.url}/stall.png)\n` +
        `03.png  ${server.url}/escape  2 images still loading after 5 s (first: ${server.url}/stall.png)\n`,
    );
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
    expect(readFileSync(join(p, "out", "run1", "vh", "d1", "shots.txt"), "utf8")).toBe(`01.png  ${server.url}/vh\n`);
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
    expect(readdirSync(join(out, "idle", "d1")).sort()).toEqual(["01.png", "02.png", "03.png", "shots.txt"]);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["01.png", "failed.png", "shots.txt"]);
    expect(readdirSync(join(out, "throws", "d1")).sort()).toEqual(["01.png", "failed.png", "shots.txt"]);
    expect(pngSize(join(out, "stuck", "d1", "failed.png"))).toEqual([320, 200]);
    expect(readFileSync(join(out, "throws", "d1", "shots.txt"), "utf8")).toBe(
      `01.png  ${server.url}/throws\nfailed.png  ${server.url}/throws-next\n`,
    );

    // No timeout stays no timeout: the deadline is never touched.
    const z = await playwright(p, ["stuck\\.capture", "--timeout", "0"]);
    expect(z.status).toBe(0);
    expect(readdirSync(join(out, "stuck", "d1")).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
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
    expect(existsSync(join(dir, ".screenshots/run1/w/d1/01.png"))).toBe(true);
  });
});

describe("plugins", () => {
  it("runs begin before the body, afterSnap per shot, done once a capture passed and failed once it failed; a throwing hook fails the capture, naming the plugin", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { appendFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineConfig } from "snapseq";
const log = (ctx, line) => appendFileSync(join(ctx.seq.dir, "hooks.txt"), line + "\\n");
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: { d1: { viewport: { width: 320, height: 200 } } },
  screenshotsDir: "out",
  plugins: [
    {
      name: "probe",
      begin: async (ctx) => ctx.page.route("**/marker", (route) => route.fulfill({ body: "ok" })),
      afterSnap: async (shot, ctx) => log(ctx, \`shot \${shot.name} \${shot.options.tag ?? "-"} \${ctx.device}\`),
      done: async (shots, ctx) => log(ctx, \`capture \${shots.map((s) => s.name).join(",")}\`),
      failed: async (shots, ctx) => log(ctx, \`failed \${shots.map((s) => s.name).join(",")} png=\${existsSync(join(ctx.seq.dir, "failed.png"))}\`),
    },
    {
      name: "boom",
      begin: async (ctx) => { if (basename(dirname(ctx.seq.dir)) === "early") throw new Error("early"); },
      afterSnap: async (shot) => { if (shot.url.endsWith("/boom")) throw new Error("kaput"); },
      done: async (shots) => { if (shots[0]?.url.endsWith("/late")) throw new Error("late"); },
    },
  ],
});
`,
      captures: {
        "pass.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/pass"); await seq.snap({ tag: "x" }); await seq.snap(); });
`,
        "fails.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/fails"); await seq.snap(); throw new Error("after one shot"); });
`,
        "boom.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/boom"); await seq.snap(); });
`,
        "late.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/late"); await seq.snap(); });
`,
        "empty.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/empty"); void seq; });
`,
        "marker.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => {
  const r = await page.goto("/marker");
  if ((await r!.text()) !== "ok") throw new Error("begin did not run first");
  await seq.snap();
});
`,
        "early.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq }) => { await page.goto("/early"); await seq.snap(); });
`,
      },
    });
    dirs.push(p);

    const r = await playwright(p, ["--max-failures", "0"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("4 failed");
    expect(r.out).toContain("3 passed");
    const out = join(p, "out", "run1");
    const read = (name: string, file: string) => readFileSync(join(out, name, "d1", file), "utf8");
    expect(read("pass", "hooks.txt")).toBe("shot 01.png x d1\nshot 02.png - d1\ncapture 01.png,02.png\n");
    expect(read("fails", "hooks.txt")).toBe("shot 01.png - d1\nfailed 01.png png=true\n"); // failed, not done, and after failed.png
    expect(read("empty", "hooks.txt")).toBe("capture \n"); // used seq, took no shot: the hook still runs
    expect(read("marker", "hooks.txt")).toBe("shot 01.png - d1\ncapture 01.png\n"); // the route begin set answered the body's goto
    // A shot whose hook threw is written but not listed.
    expect(r.out).toContain('snapseq: plugin "boom" threw in afterSnap on 01.png: kaput');
    expect(existsSync(join(out, "boom", "d1", "01.png"))).toBe(true);
    expect(read("boom", "shots.txt")).toBe(`failed.png  ${server.url}/boom\n`);
    expect(r.out).toContain('snapseq: plugin "boom" threw in done: late');
    // A begin that throws fails the capture before its body runs: no shot, no failed.png.
    expect(r.out).toContain('snapseq: plugin "boom" threw in begin: early');
    expect(readdirSync(join(out, "early", "d1"))).toEqual([]);
  });

  it("snapseq-label adds a strip to a labeled shot and snapseq-pdf binds the capture, labels included", async () => {
    const p = makeProject({
      esm: true,
      config: `
import { defineConfig } from "snapseq";
import { label } from "snapseq-label";
import { pdf } from "snapseq-pdf";
export default defineConfig({
  envs: { dev: { host: "${server.url}" } },
  devices: {
    d1: { viewport: { width: 400, height: 300 } },
    // A phone: 2x, mobile layout. The plugins' own contexts must not inherit either.
    d2: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  },
  screenshotsDir: "out",
  plugins: [label(), pdf()],
});
`,
      captures: {
        "home.capture.ts": `
import { capture } from "snapseq";
capture(async ({ page, seq, device }) => {
  await page.goto("/home");
  await seq.snap({ label: "0.0 Home" });
  // The test page has no viewport meta tag, so mobile emulation scales it and snapPage refuses it.
  if (device === "d1") await seq.snapPage({ label: "0.1 Home, whole page" });
  await seq.snap();
});
`,
      },
    });
    dirs.push(p);

    const r = await playwright(p, []);
    expect(r.out).toContain("2 passed");
    expect(r.status).toBe(0);
    const dir = join(p, "out", "run1", "home", "d1");
    expect(readdirSync(dir).sort()).toEqual(["01.png", "02.png", "03.png", "shots.txt"]);
    expect(pngSize(join(dir, "01.png"))).toEqual([400, 324]); // 24 px strip
    const [, full] = pngSize(join(dir, "02.png"));
    expect(full).toBeGreaterThan(924); // the whole 900 px page, plus the strip
    expect(pngSize(join(dir, "03.png"))).toEqual([400, 300]); // no label, untouched
    expect(readFileSync(join(dir, "shots.txt"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    // The PDFs sit next to the device folders. One page per shot at the labeled size: 1 px is 0.75 pt.
    expect(readdirSync(join(p, "out", "run1", "home")).sort()).toEqual(["d1", "d1.pdf", "d2", "d2.pdf"]);
    expect(await pdfPages(join(dir, "..", "d1.pdf"))).toEqual([
      [300, 243],
      [300, full * 0.75],
      [300, 225],
    ]);
    // The phone: 780 px wide at 2x, the strip 24 px of the file, nothing scaled.
    // (Mobile emulation makes the 844 px viewport 1687 px tall, so measure, don't assume.)
    const phone = join(p, "out", "run1", "home", "d2");
    const [width, height] = pngSize(join(phone, "02.png")); // unlabeled
    expect(width).toBe(780);
    expect(pngSize(join(phone, "01.png"))).toEqual([width, height + 24]);
    // Pages are the CSS size: the 2x file halved, so the phone page is phone-sized.
    expect(await pdfPages(join(phone, "..", "d2.pdf"))).toEqual([
      [(width / 2) * 0.75, ((height + 24) / 2) * 0.75],
      [(width / 2) * 0.75, (height / 2) * 0.75],
    ]);
  });
});

describe("run directory", () => {
  it("stamps each run with a Finder-style local-time dir and keeps Playwright's artifacts out of the screenshots dir", async () => {
    const r = await playwright(project, ["a\\.capture", "--project", "d1"], { SNAPSEQ_RUN: "" });
    expect(r.status).toBe(0);
    const out = join(project, "out");
    const runs = readdirSync(out).filter((n) =>
      /^\d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2} [AP]M$/.test(n),
    );
    expect(runs).toHaveLength(1);
    expect(readdirSync(join(out, runs[0]!, "a", "d1")).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
    expect(existsSync(join(out, ".playwright"))).toBe(false);
    expect(existsSync(join(project, "node_modules", ".cache", "snapseq", ".last-run.json"))).toBe(
      true,
    );
  });
});
