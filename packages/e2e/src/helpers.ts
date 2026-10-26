import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { PKG, PNG_1x1, PW_CLI, listen, makeApp, node, pngSize } from "../../snapseq/src/__tests__/harness.js";

// Drives the BUILT package through the real Playwright CLI, the way a consumer would.
export { PKG, pngSize };
export const AUTH = `Basic ${Buffer.from("u:p").toString("base64")}`;
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
export const FONT = [
  "/System/Library/Fonts/Supplemental/Verdana.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
].find((f) => existsSync(f));
const FONT_PAGE = `<!doctype html><html><head><style>@font-face { font-family: Late; src: url(/slow-font.ttf); size-adjust: 150%; font-display: swap } body { margin: 0; font: 24px Late, Arial }</style></head><body>${"<div>The measured height changes with the font.</div>".repeat(25)}</body></html>`;
// A block as tall as the viewport, then 500 px more: the page grows with every viewport the shot sets.
const VH_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:100vh;background:#cde"></div><div style="height:500px;background:#eee"></div></body></html>`;

// 3000 px of content and a 200 px spacer under it that a resize handler removes once the viewport is taller than 2000 px, as a scroll
// handler takes a tray and its spacer away: the page is then shorter than the viewport that was grown to its old height. A fixed bar
// with a child sits at the viewport's end. A hidden block holds a box with margin: auto, which computes to "auto", not a length.
// ?stay keeps the spacer, and ends it with a margin that collapses through <body>.
const SHRINK_PAGE = (stay: boolean) => `<!doctype html><html><body style="margin:0"><div style="height:3000px;background:#cde"></div>
<div id="spacer" style="height:200px;background:#eee;${stay ? "margin-bottom:20px" : ""}"></div>
<div style="position:fixed;bottom:0;left:0;right:0;background:#f00"><div style="height:40px;margin-bottom:20px"></div></div>
<div style="display:none"><div style="margin:auto">hidden</div></div>
<script>addEventListener("resize", () => { if (innerHeight > 2000 && ${!stay}) document.getElementById("spacer").remove(); });</script></body></html>`;

// 3000 px of content and a last box that the box measure of snapPage could read short: ?neg ends with margin-bottom: -1px; ?text is a
// 40 px box whose text wraps past it, which scrollHeight counts and the boxes do not; ?both is that box, then a 200 px spacer that a
// resize handler removes: the page looks shorter by its boxes and is not.
const EDGE_TEXT = "The quick brown fox jumps over the lazy dog again and again";
const EDGE_PAGE = (kind: string) => `<!doctype html><html><body style="margin:0"><div style="height:3000px;background:#cde"></div>${
  kind === "neg"
    ? '<div style="height:200px;background:#eee;margin-bottom:-1px"></div>'
    : `<div style="height:40px;width:100px;background:#eee">${EDGE_TEXT}</div>${
        kind === "both"
          ? '<div id="spacer" style="height:200px"></div><script>addEventListener("resize", () => { if (innerHeight > 2000) document.getElementById("spacer").remove(); });</script>'
          : ""
      }`
}</body></html>`;

// A lazy image 2000 px down whose bytes arrive 1.5 s after they are asked for; 100 px tall once loaded.
const LAZY_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:2000px"></div><img id="lazy" loading="lazy" src="/slow.png" style="display:block;width:100px"></body></html>`;
// Renders one field of a JSON response, so a replayed body shows in the page.
const WIDGET_PAGE = `<!doctype html><html><body><h1 id="v"></h1><script>fetch("/api").then((r) => r.json()).then((j) => { document.getElementById("v").textContent = j.v; });</script></body></html>`;

interface Hit {
  url: string;
  ua: string;
  auth?: string;
}

export function startServer() {
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
    if (url.startsWith("/shrink")) return void res.end(SHRINK_PAGE(url.includes("stay")));
    if (url.startsWith("/edge")) return void res.end(EDGE_PAGE(url.split("?")[1] ?? ""));
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
  return listen(server, hits);
}

export function makeProject(opts: {
  esm: boolean;
  config: string;
  sequences: Record<string, string>;
}): string {
  const dir = makeApp(mkdtempSync(join(tmpdir(), "snapseq-it-")), {
    ...(opts.esm ? {} : { "package.json": "{}" }),
    "snapseq.config.ts": opts.config,
    ...Object.fromEntries(Object.entries(opts.sequences).map(([rel, src]) => [`snapseq/${rel}`, src])),
  });
  // The workspace's label and pdf steps, built by their own prepare/test scripts.
  mkdirSync(join(dir, "node_modules", "@snapseq"), { recursive: true });
  for (const name of ["label", "pdf"]) {
    symlinkSync(resolve(PKG, "..", name), join(dir, "node_modules", "@snapseq", name));
  }
  return dir;
}

export const playwright = (dir: string, args: string[], env?: Record<string, string>) =>
  node([PW_CLI, "test", "-c", join(dir, "snapseq.config.ts"), ...args], dir, { SNAPSEQ_RUN: "run1", ...env });

// The snapseq bin, run from `cwd` (defaults to the project dir).
export const snapseq = (dir: string, args: string[], env?: Record<string, string>, cwd: string = dir) =>
  node([join(PKG, "dist", "cli.js"), ...args], cwd, { SNAPSEQ_RUN: "run1", ...env });

// Page sizes in pt. pdf-lib writes compressed object streams, so a grep for MediaBox sees nothing.
export const pdfPages = async (file: string) =>
  (await PDFDocument.load(readFileSync(file))).getPages().map((p) => [p.getWidth(), p.getHeight()]);
