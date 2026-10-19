import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the BUILT package through the real Playwright CLI, the way a consumer would.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CORE = resolve(PKG, "..", "snapseq");
const PW_CLI = join(PKG, "node_modules/@playwright/test/cli.js");
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// A fixed header and banner, a 100vh hero, a sticky sub-header right below it, a sticky aside and 8 blocks:
// 720 + 40 + 3200 = 3960 px tall at the 1280x720 viewport.
const PROBE_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#header { position: fixed; top: 0; left: 0; right: 0; height: 60px; background: #f00 }
#banner { position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: #00f }
#hero { height: 100vh; background: #ccc }
#sub { position: sticky; top: 60px; height: 40px; background: #0f0 }
main { display: flex }
#aside { position: sticky; top: 100px; align-self: flex-start; width: 200px; height: 100px; background: #ff0 }
.block { height: 400px; background: #eee }
html > :not(head):not(body) { display: none !important } /* reaches whatever the plugin appends to <html> to measure with */
</style></head><body>
<div id="header"></div><div id="banner"></div><div id="hero"></div><div id="sub"></div>
<main><aside id="aside"></aside><div style="flex: 1">${'<div class="block"></div>'.repeat(8)}</div></main>
</body></html>`;

// A resize handler adds CSS: while snapPage has the viewport grown, #late gets its 100vh.
const LATE_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:1000px"></div><div id="late"></div><script>
addEventListener("resize", () => {
  if (document.getElementById("lateStyle")) return;
  const s = document.createElement("style");
  s.id = "lateStyle";
  s.textContent = "#late { height: 100vh }";
  document.head.append(s);
});
</script></body></html>`;

// Every kind of declaration the freeze has to reach, and the strings it has to leave alone.
const keepPage = (cdn: string) => `<!doctype html><html><head>
<link rel="stylesheet" href="${cdn}/style.css">
<style>@import url("/imported.css");</style>
<style>
body { margin: 0 }
:root { --h: 50vh }
#pri { height: 100vh !important }
#cv { height: var(--h) }
#fb { min-height: var(--x, 100vh) }
#inset { position: fixed; inset: 0 0 10vh; width: 10px; background: #f0f }
#q::before { content: "100vh" }
#u { background: url("/100vh.png") }
@media (min-width: 100px) { #media { height: 50vh } }
.a { & .b { height: 50vh } }
#vmin { height: 10vmin }
</style></head><body>
<div id="pri"></div><div id="cv"></div><div id="fb"></div><div id="inset"></div><div id="q"></div><div id="u"></div>
<div id="media"></div><div id="imp"></div><div class="a"><div class="b" id="nest"></div></div><div id="vmin"></div>
<div id="inl" style="height: 50vh"></div><div id="xo"></div>
<script>
const rule = (selector) => {
  for (const sheet of document.styleSheets) for (const r of sheet.cssRules) if (r.selectorText === selector) return r;
};
window.__facts = () => ({
  before: getComputedStyle(document.getElementById("q"), "::before").content,
  priority: rule("#pri").style.getPropertyPriority("height"),
  priValue: rule("#pri").style.getPropertyValue("height"),
  insetBottom: getComputedStyle(document.getElementById("inset")).bottom,
  background: getComputedStyle(document.getElementById("u")).backgroundImage,
  custom: getComputedStyle(document.documentElement).getPropertyValue("--h").trim(),
});
</script></body></html>`;

// A stylesheet that redirects.
const redirectPage = (cdn: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="${cdn}/old/style.css"></head><body style="margin:0"><div id="hero"></div><div style="height:1000px"></div></body></html>`;

// A document written into a frame built by script: the frame has not committed a URL of its own yet when the sheet is requested.
const iframePage = (cdn: string) => `<!doctype html><html><body style="margin:0"><div style="height:1000px"></div><script>
const frame = document.createElement("iframe");
document.body.appendChild(frame);
frame.contentDocument.open();
frame.contentDocument.write('<link rel="stylesheet" href="${cdn}/style.css"><p>in the frame</p>');
frame.contentDocument.close();
</script></body></html>`;

// Widgets that land in resize handlers, while snapPage has the viewport grown: a <style> inside an added
// subtree, then, in the next resize, an element that carries its own style attribute.
const WIDGET_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:1000px"></div><div id="host"></div><div id="host2"></div><script>
let resizes = 0;
addEventListener("resize", () => {
  resizes++;
  if (resizes === 1) document.getElementById("host").innerHTML = '<section><style>#w { height: 100vh }</style><div id="w"></div></section>';
  if (resizes === 2) document.getElementById("host2").innerHTML = '<div id="w2" style="position: absolute; top: 0; height: 50vh"></div>';
});
</script></body></html>`;

// A cross-origin sheet that is imported, so there is no <link> to fetch again.
const importPage = (cdn: string) =>
  `<!doctype html><html><head><style>@import url("${cdn}/style.css");</style></head><body style="margin:0"><div id="xo"></div></body></html>`;

// A cross-origin sheet that a script turned off, as a theme switch does: no attribute, only the sheet's flag.
const disabledPage = (cdn: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="${cdn}/style.css"></head><body style="margin:0"><div id="xo"></div><script>
addEventListener("load", () => { document.styleSheets[0].disabled = true; });
</script></body></html>`;

// A page that lies about its own stylesheets: a cross-origin JSON file, reported as an unreadable sheet through an overridden
// document.styleSheets. When the plugin adds its clone, the page fetches that JSON itself, hoping the plugin's route answers it with a CORS header.
const hostilePage = (cdn: string) => `<!doctype html><html><head><link id="l" rel="stylesheet" href="${cdn}/secret.json"></head><body style="margin:0"><div style="height:1000px"></div><script>
const link = document.getElementById("l");
Object.defineProperty(document, "styleSheets", {
  get: () => [{ href: link.href, disabled: false, ownerNode: link, get cssRules() { throw new DOMException("blocked", "SecurityError"); } }],
});
window.__leak = new Promise((done) => {
  new MutationObserver((records) => {
    if (records.some((r) => Array.from(r.addedNodes).some((n) => n.tagName === "LINK"))) done(fetch("${cdn}/secret.json").then((r) => r.ok).catch(() => false));
  }).observe(document.head, { childList: true });
});
window.__facts = async () => ({ leaked: String(await Promise.race([window.__leak, new Promise((done) => setTimeout(() => done("never"), 3000))])) });
</script></body></html>`;

const flakyPage = (cdn: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="${cdn}/flaky.css?sig=abc"></head><body style="margin:0"><div id="flaky"></div></body></html>`;

// Open shadow roots: a <style> in one, a constructed sheet shared by two, a nested root with its own <style>,
// and a constructed sheet on the document. 72 + 720 + 360 + 360 + 180 = 1692 px tall at the 1280x720 viewport.
const SHADOW_PAGE = `<!doctype html><html><body style="margin:0">
<div id="doc"></div><x-open id="open"></x-open><x-adopted id="a1"></x-adopted><x-adopted id="a2"></x-adopted><x-outer id="outer"></x-outer>
<script>
const shared = new CSSStyleSheet();
shared.replaceSync(":host { display: block; height: 50vh }");
const own = new CSSStyleSheet();
own.replaceSync("#doc { height: 10vh }");
document.adoptedStyleSheets = [own];
const define = (name, html, sheets = []) =>
  customElements.define(name, class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = html;
      root.adoptedStyleSheets = sheets;
    }
  });
define("x-open", "<style>:host { display: block; height: 100vh }</style>");
define("x-adopted", "", [shared]);
define("x-inner", "<style>:host { display: block; height: 25vh }</style>");
define("x-outer", "<style>:host { display: block }</style><x-inner id='inner'></x-inner>");
// A resize handler adds a <style> and an element to a root that is already there.
addEventListener("resize", () => {
  const root = document.getElementById("open").shadowRoot;
  if (root.getElementById("sh")) return;
  const style = document.createElement("style");
  style.textContent = "#sh { display: block; height: 20vh }";
  const div = document.createElement("div");
  div.id = "sh";
  root.append(style, div);
});
</script></body></html>`;

// A resize handler writes viewport units into CSS that is already in the page: an inline style, and the text of a <style>.
const REWRITE_PAGE = `<!doctype html><html><body style="margin:0"><style id="txt">#c { height: 1px }</style>
<div id="grow"></div><div id="c"></div><div style="height:1000px"></div><script>
addEventListener("resize", () => {
  document.getElementById("grow").style.height = "100vh";
  document.getElementById("txt").firstChild.data = "#c { height: 50vh }";
});
</script></body></html>`;

// A resize handler does nothing but write an inline height on an element already in the page: no <style>, no added node.
const INLINE_PAGE = `<!doctype html><html><body style="margin:0"><div id="grow"></div><div style="height:1000px"></div><script>
addEventListener("resize", () => { document.getElementById("grow").style.height = "100vh"; });
</script></body></html>`;

// The document is scaled: a bounding rect is half of what the computed height says.
const TRANSFORM_PAGE = `<!doctype html><html><head><style>html { transform: scale(0.5); transform-origin: 0 0 } #tall { height: 100vh }</style></head>
<body style="margin:0"><div id="tall"></div><script>
window.__facts = () => ({ height: getComputedStyle(document.getElementById("tall")).height });
</script></body></html>`;

// An inline value the sequence rewrites between the shots: the same px, now !important.
const PRIORITY_PAGE = `<!doctype html><html><body style="margin:0"><div id="p" style="height: 100vh"></div><script>
window.__facts = () => {
  const s = document.getElementById("p").style;
  return { value: s.getPropertyValue("height"), priority: s.getPropertyPriority("height") };
};
</script></body></html>`;

// A sheet link added by the sequence right before the shot, so it is still loading when the freeze begins: the server holds it back.
const SLOWLINK_PAGE = `<!doctype html><html><body style="margin:0"><div id="slow"></div><div style="height:1000px"></div></body></html>`;

// A cross-origin sheet whose href carries a fragment, which no request URL does.
const fragmentPage = (cdn: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="${cdn}/style.css#x"></head><body style="margin:0"><div id="xo"></div><div style="height:1000px"></div></body></html>`;

// A resize handler starts a minute-long animation, after the plugin's pass and before the screenshot.
const ANIM_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:1000px"></div><div id="anim">a</div><script>
let started = false;
addEventListener("resize", () => {
  if (started) return;
  started = true;
  document.getElementById("anim").animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 60000, fill: "forwards" });
});
window.__facts = () => ({ opacity: getComputedStyle(document.getElementById("anim")).opacity });
</script></body></html>`;

// 1000 px tall, and its body follows the viewport through script: no viewport could ever contain it.
const FOLLOW_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:1000px"></div><script>
addEventListener("resize", () => { document.body.style.height = innerHeight * 2 + "px"; });
</script></body></html>`;

// A finite no-fill animation, a forwards-fill one, an infinite one, a chained one started by the first one's
// finish handler, an SVG <animate>, a CSS spin and a reduced-motion rule. The finite ones last a minute: only the
// plugin can bring them to their end state before the shot.
const MOTION_PAGE = `<!doctype html><html><head><style>
@keyframes spin { to { transform: rotate(1turn) } }
#css { animation: spin 1s linear infinite; width: 50px; height: 50px; background: #09f }
#rm { height: 20px; background: rgb(9, 9, 9) }
@media (prefers-reduced-motion: reduce) { #rm { background: rgb(1, 2, 3) } }
</style></head><body style="margin:0">
<div id="nofill">a</div><div id="fwd">b</div><div id="inf">c</div><div id="chain">d</div><div id="css"></div><div id="rm"></div>
<svg width="100" height="40"><rect width="20" height="20"><animate attributeName="x" from="0" to="80" dur="1s" repeatCount="indefinite"/></rect></svg>
<svg id="draw" width="100" height="10"><rect id="bar" height="10"><animate attributeName="width" from="0" to="80" dur="0.5s" fill="freeze"/></rect></svg>
<script>
document.getElementById("draw").setCurrentTime(1); // the draw-in is over
const el = (id) => document.getElementById(id);
el("nofill").animate([{ opacity: 0 }, { opacity: 0.2 }], { duration: 60000 });
el("fwd").animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 60000, fill: "forwards" });
el("inf").animate([{ transform: "translateX(0)" }, { transform: "translateX(100px)" }], { duration: 1000, iterations: Infinity });
const first = el("chain").animate([{ opacity: 1 }, { opacity: 0.4 }], { duration: 60000 });
first.onfinish = () => el("chain").animate([{ width: "10px" }, { width: "90px" }], { duration: 60000, fill: "forwards" });
document.body.append(document.createElement("svg")); // no pauseAnimations on this one
const foreign = document.createElementNS("urn:x-foreign", "foreign"); // no .style on this one
foreign.setAttribute("style", "height: 5vh");
document.body.append(foreign);
window.__facts = () => ({
  nofill: getComputedStyle(el("nofill")).opacity,
  fwd: getComputedStyle(el("fwd")).opacity,
  chain: getComputedStyle(el("chain")).width,
  rm: getComputedStyle(el("rm")).backgroundColor,
  bar: String(el("bar").width.animVal.value),
});
</script></body></html>`;

// A click inserts 300 px above the button, which moves the card under the still pointer: the button sits at 300-340 px
// before the click, at 600-640 after it, and the click was at y 320.
const HOVER_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#go { display: block; width: 200px; height: 40px }
#card { display: block; height: 300px; background: rgb(10, 20, 30) }
#card:hover { background: rgb(40, 50, 60) }
</style></head><body><div id="slot"></div><div id="card"></div><button id="go">go</button><script>
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("slot").style.height = "300px";
});
// What an exit-intent script sees: the height at which the pointer left the document.
document.addEventListener("mouseleave", (e) => (window.leftAt = e.clientY));
window.__facts = () => ({ card: getComputedStyle(document.getElementById("card")).backgroundColor, leftAt: String(window.leftAt) });
</script></body></html>`;

// Ten screens of 700 px; the observer reveals a section (opacity 0 until then) and swaps the data-src of the last one's image.
const REVEAL_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
section { height: 700px; opacity: 0 }
section.in { opacity: 1 }
</style></head><body>${Array.from({ length: 10 }, (_, i) => `<section id="s${i + 1}">${i === 9 ? '<img id="lazy" data-src="/lazy.png" alt="">' : ""}</section>`).join("")}<script>
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    for (const img of e.target.querySelectorAll("img[data-src]")) img.src = img.dataset.src;
  }
});
document.querySelectorAll("section").forEach((s) => io.observe(s));
window.__facts = () => ({
  last: getComputedStyle(document.getElementById("s10")).opacity,
  mid: getComputedStyle(document.getElementById("s3")).opacity,
  src: document.getElementById("lazy").currentSrc,
  y: String(scrollY),
});
</script></body></html>`;

// Hydration: a loading line ticks every 100 ms and, at 300 ms, the script inserts ten screens of 700 px and the
// lazy image. The observer reveals them as in REVEAL_PAGE. Nothing of it exists when the scroll pass would start.
const HYDRATE_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
section { height: 700px; opacity: 0 }
section.in { opacity: 1 }
</style></head><body><p id="boot"></p><script>
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    for (const img of e.target.querySelectorAll("img[data-src]")) img.src = img.dataset.src;
  }
});
let tick = 0;
const timer = setInterval(() => {
  document.getElementById("boot").textContent = "loading " + ++tick;
  if (tick < 3) return;
  clearInterval(timer);
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement("section");
    s.id = "s" + i;
    if (i === 10) s.innerHTML = '<img id="lazy" data-src="/lazy.png" alt="">';
    document.body.append(s);
    io.observe(s);
  }
}, 100);
window.__facts = () => ({
  total: String(document.querySelectorAll("section").length),
  revealed: String(document.querySelectorAll("section.in").length),
  src: document.getElementById("lazy")?.currentSrc ?? "",
});
</script></body></html>`;

// Far more than 60 screens, scrolled to 300 px first; the way down from the top reaches the cap.
const LONG_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:80000px"></div><script>
scrollTo(0, 300);
window.__facts = () => ({ y: String(scrollY) });
</script></body></html>`;

// What the config hands to Playwright. The probe writes, beside each shot and while snapPage still has the
// viewport grown, the geometry of every element with an id, inside open shadow roots too. STAB is the plugin's options as JSON; NO_STAB leaves it out.
const CONFIG = (host: string) => `
import { writeFileSync } from "node:fs";
import { defineConfig } from "snapseq";
import { stabilize } from "@snapseq/stabilize";

const probe = () => ({
  name: "probe",
  async afterSnap(shot, ctx) {
    const data = await ctx.page.evaluate(async () => {
      const inRoot = (root) => Array.from(root.querySelectorAll("*")).flatMap((e) => [e, ...(e.shadowRoot ? inRoot(e.shadowRoot) : [])]);
      return {
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      running: document.getAnimations().filter((a) => a.playState === "running").length,
      infinite: document.getAnimations().filter((a) => a.playState === "running" && a.effect.getComputedTiming().endTime === Infinity).length,
      rects: Object.fromEntries(inRoot(document).filter((e) => e.id).map((e) => [e.id, e.getBoundingClientRect().toJSON()])),
      facts: window.__facts ? await window.__facts() : null,
      };
    });
    writeFileSync(shot.path.replace(/\\.[a-z]+$/, ".json"), JSON.stringify(data));
  },
});

export default defineConfig({
  envs: { dev: { host: "${host}" } },
  devices: { d1: { viewport: { width: 1280, height: 720 } } },
  screenshotsDir: "out",
  plugins: process.env.NO_STAB ? [probe()] : [stabilize(JSON.parse(process.env.STAB ?? "{}")), probe()],
});
`;

const SEQUENCES: Record<string, string> = {
  snappage: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/probe");
  await seq.snapPage();
});
`,
  fullpage: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/probe");
  await seq.snap({ fullPage: true });
});
`,
  resized: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/probe");
  await seq.snap();
  await page.setViewportSize({ width: 1280, height: 900 });
  await seq.snapPage();
});
`,
  late: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/late");
  await seq.snapPage();
});
`,
  keep: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/keep");
  await seq.snapPage();
});
`,
  sheets: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/import");
  await seq.snap();
  await page.goto("/disabled");
  await seq.snap();
});
`,
  redirect: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/redirect");
  await seq.snap();
});
`,
  iframe: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/iframe");
  await seq.snapPage();
});
`,
  widget: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/widget");
  await seq.snapPage();
});
`,
  flaky: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/flaky");
  await page.evaluate(async () => { for (const u of ["/cached.txt?a", "/cached.txt?a"]) await fetch(u); });
  await seq.snap();
  await page.evaluate(async () => { for (const u of ["/cached.txt?b", "/cached.txt?b"]) await fetch(u); });
  await seq.snap();
});
`,
  hostile: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/hostile");
  await seq.snap();
});
`,
  shadow: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/shadow");
  await seq.snapPage();
});
`,
  rewrite: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/rewrite");
  await seq.snapPage();
});
`,
  inline: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/inline");
  await seq.snapPage();
});
`,
  transform: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/transform");
  await seq.snap();
});
`,
  priority: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/priority");
  await seq.snap();
  await page.evaluate(() => {
    const s = document.getElementById("p").style;
    s.setProperty("height", s.getPropertyValue("height"), "important");
  });
  await seq.snap();
});
`,
  slowlink: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/slowlink");
  await page.evaluate(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/slow.css";
    document.head.append(link);
  });
  await seq.snapPage();
});
`,
  fragment: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/fragment");
  await seq.snapPage();
});
`,
  anim: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/anim");
  await seq.snapPage();
});
`,
  follow: `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/follow");
  let refused = "";
  try {
    await seq.snapPage();
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  writeFileSync(join(seq.dir, "refused.txt"), refused + "\\nviewport height " + page.viewportSize()?.height);
  await seq.snap();
});
`,
  hover: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/hover");
  await page.click("#go");
  // The browser hovers what is under a still pointer once the layout changed: wait for it, so the shot is of a hovered card.
  await page.waitForFunction(() => document.getElementById("card").matches(":hover"));
  await seq.snap();
});
`,
  hoverkeep: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/hover");
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("card").matches(":hover"));
  await seq.snap({ hover: "keep" });
});
`,
  reveal: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/reveal");
  await seq.snap({ fullPage: true });
});
`,
  hydrate: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/hydrate");
  await seq.snap({ fullPage: true });
});
`,
  revealsnap: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/reveal");
  await seq.snap();
});
`,
  revealmid: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/reveal");
  await page.evaluate(() => scrollTo(0, 6000)); // the sections above were never in view
  await seq.snap({ fullPage: true });
});
`,
  long: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/long");
  await seq.snap({ fullPage: true, clip: { x: 0, y: 0, width: 100, height: 100 } });
});
`,
  motion: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/motion");
  await seq.snap();
  await seq.snap();
});
`,
};

function startServer(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handle(req, res);
  });
  return new Promise<{ url: string; hits: string[]; close: () => Promise<void> }>((ok) => {
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

function send(res: ServerResponse, type: string, body: string | Buffer, status = 200) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

// The stylesheets carry no access-control-allow-origin: the plugin's route has to supply it.
const secretCookies: string[] = []; // the cookie header of every request for /secret.json, "" for none

function cdnServer() {
  let flakyRequests = 0;
  return startServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/secret.json")) {
      secretCookies.push(req.headers.cookie ?? "");
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=s3cret; Path=/" });
      res.end('{"secret":true}');
    } else if (url.startsWith("/style.css")) send(res, "text/css", "#xo { height: 100vh; background: url(img.png) }");
    else if (url.startsWith("/img.png") || url.startsWith("/v1/img.png")) send(res, "image/png", PNG_1x1);
    else if (url.startsWith("/old/style.css")) {
      res.writeHead(302, { location: "/v1/style.css" });
      res.end();
    } else if (url.startsWith("/v1/style.css")) send(res, "text/css", "#hero { height: 100vh; background: url(img.png) }");
    // The first request answers, the CORS refetch of the plugin gets a 500.
    else if (url.startsWith("/flaky.css")) {
      if (++flakyRequests > 1) send(res, "text/css", "boom", 500);
      else send(res, "text/css", "#flaky { height: 100vh }");
    } else send(res, "text/plain", "not found", 404);
  });
}

function appServer(cdn: string) {
  const pages: Record<string, string> = {
    "/probe": PROBE_PAGE,
    "/late": LATE_PAGE,
    "/keep": keepPage(cdn),
    "/flaky": flakyPage(cdn),
    "/hostile": hostilePage(cdn),
    "/redirect": redirectPage(cdn),
    "/iframe": iframePage(cdn),
    "/widget": WIDGET_PAGE,
    "/import": importPage(cdn),
    "/disabled": disabledPage(cdn),
    "/shadow": SHADOW_PAGE,
    "/rewrite": REWRITE_PAGE,
    "/inline": INLINE_PAGE,
    "/transform": TRANSFORM_PAGE,
    "/priority": PRIORITY_PAGE,
    "/slowlink": SLOWLINK_PAGE,
    "/fragment": fragmentPage(cdn),
    "/anim": ANIM_PAGE,
    "/follow": FOLLOW_PAGE,
    "/motion": MOTION_PAGE,
    "/hover": HOVER_PAGE,
    "/reveal": REVEAL_PAGE,
    "/hydrate": HYDRATE_PAGE,
    "/long": LONG_PAGE,
  };
  return startServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const page = pages[path];
    if (path === "/imported.css") send(res, "text/css", "#imp { height: 25vh }");
    else if (path === "/lazy.png") send(res, "image/png", PNG_1x1);
    else if (path === "/slow.css") setTimeout(() => send(res, "text/css", "#slow { height: 100vh }"), 300);
    else if (path === "/cached.txt") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" });
      res.end("x");
    }
    else if (page) send(res, "text/html", page);
    else send(res, "text/plain", "not found", 404);
  });
}

function makeProject(host: string): string {
  const dir = mkdtempSync(join(tmpdir(), "snapseq-stab-"));
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "@snapseq"), { recursive: true });
  symlinkSync(CORE, join(dir, "node_modules", "snapseq"));
  symlinkSync(PKG, join(dir, "node_modules", "@snapseq", "stabilize"));
  // The consumer's own Playwright; same realpath as the core's, so one runner instance.
  symlinkSync(join(PKG, "node_modules", "@playwright", "test"), join(dir, "node_modules", "@playwright", "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "snapseq.config.ts"), CONFIG(host));
  mkdirSync(join(dir, "snapseq"));
  for (const [name, src] of Object.entries(SEQUENCES)) writeFileSync(join(dir, "snapseq", `${name}.seq.ts`), src);
  return dir;
}

// Async on purpose: the fixture HTTP servers run in this process, so a sync spawn would block them.
function playwright(dir: string, args: string[], env: Record<string, string>) {
  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SNAPSEQ_") && k !== "STAB" && k !== "NO_STAB") spawnEnv[k] = v;
  }
  return new Promise<{ status: number | null; out: string }>((ok) => {
    const child = spawn(process.execPath, [PW_CLI, "test", "-c", join(dir, "snapseq.config.ts"), ...args], {
      cwd: dir,
      env: { ...spawnEnv, ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => ok({ status, out }));
  });
}

function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

async function image(file: string) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { at: (x: number, y: number) => [0, 1, 2].map((c) => data[(y * info.width + x) * info.channels + c]) };
}

interface Probe {
  innerHeight: number;
  scrollHeight: number;
  running: number;
  infinite: number;
  rects: Record<string, { x: number; y: number; width: number; height: number; top: number; bottom: number }>;
  facts: Record<string, string> | null;
}
const probe = (dir: string, shot = "01"): Probe => JSON.parse(readFileSync(join(dir, `${shot}.json`), "utf8"));
// The notes the run printed, one line per shot taken with any: `snapseq: 01.png taken with <notes>  <url>`.
const noted = (out: string) => out.match(/snapseq: \d+\.png taken with .*/g) ?? [];

let cdn: Awaited<ReturnType<typeof cdnServer>>;
let app: Awaited<ReturnType<typeof appServer>>;
let project: string;
let runs = 0;

// One Playwright run of one sequence into its own run directory, so no run overwrites another's files.
async function run(sequence: string, env: Record<string, string> = {}) {
  const name = `run${++runs}`;
  const r = await playwright(project, [`${sequence}\\.seq`], { SNAPSEQ_RUN: name, ...env });
  return { ...r, dir: join(project, "out", name, sequence, "d1") };
}

beforeAll(async () => {
  cdn = await cdnServer();
  app = await appServer(cdn.url);
  project = makeProject(app.url);
});

afterAll(async () => {
  await app.close();
  await cdn.close();
  rmSync(project, { recursive: true, force: true });
});

describe("snapPage on a 100vh page", () => {
  it("passes with the plugin: hero 720 px, fixed and sticky elements in place, the shot as tall as the document", async () => {
    const r = await run("snappage");
    expect(r.status, r.out).toBe(0);
    const dir = r.dir;
    const p = probe(dir);
    expect(p.rects.hero?.height).toBe(720);
    expect(p.scrollHeight).toBe(3960);
    expect(p.innerHeight).toBe(3960);
    expect(p.rects.sub?.top).toBe(720); // sticky, right below the hero
    expect(p.rects.aside?.top).toBe(760); // sticky, at rest in flow
    expect(p.rects.banner?.bottom).toBe(3960); // fixed to the bottom of the grown viewport: the document end
    expect(pngSize(join(dir, "01.png"))).toEqual([1280, 3960]);

    const img = await image(join(dir, "01.png"));
    for (const y of [0, 30, 59]) expect(img.at(640, y)).toEqual([255, 0, 0]); // the fixed header
    for (const y of [3880, 3920, 3959]) expect(img.at(640, y)).toEqual([0, 0, 255]); // the fixed banner
    expect(img.at(640, 400)).toEqual([204, 204, 204]); // the hero
    for (const y of [720, 740, 759]) expect(img.at(640, y)).toEqual([0, 255, 0]); // the sub-header
    expect(img.at(100, 800)).toEqual([255, 255, 0]); // the aside
  });

  it("is refused without the plugin, which is what it is for", async () => {
    const r = await run("snappage", { NO_STAB: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("snapPage: the document grew");
  });

  it("is refused with viewportUnits: false", async () => {
    const r = await run("snappage", { STAB: JSON.stringify({ viewportUnits: false }) });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("snapPage: the document grew");
  });
});

describe("snap({ fullPage: true })", () => {
  it("keeps the hero at 720 px and the shot the size it is without the plugin", async () => {
    const withPlugin = await run("fullpage");
    const without = await run("fullpage", { NO_STAB: "1" });
    expect(withPlugin.status, withPlugin.out).toBe(0);
    expect(without.status, without.out).toBe(0);
    expect(probe(withPlugin.dir).rects.hero?.height).toBe(720);
    expect(pngSize(join(withPlugin.dir, "01.png"))).toEqual([1280, 3960]);
    expect(pngSize(join(withPlugin.dir, "01.png"))).toEqual(pngSize(join(without.dir, "01.png")));
  });
});

describe("a viewport that changes between shots", () => {
  // The second shot is snapPage: with live vh a plain snap gives 720 then 900 without the plugin, too.
  it("freezes the hero at 720 px, then again at 900 px, so snapPage takes the page at the new size", async () => {
    const r = await run("resized");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").rects.hero?.height).toBe(720);
    const second = probe(r.dir, "02");
    expect(second.rects.hero?.height).toBe(900);
    expect(second.scrollHeight).toBe(4140); // 900 + 40 + 3200
    expect(second.innerHeight).toBe(4140);
    expect(pngSize(join(r.dir, "02.png"))).toEqual([1280, 4140]);
  });
});

describe("CSS that arrives after the viewport grew", () => {
  it("is frozen at the viewport of the shot, not the grown one", async () => {
    const r = await run("late");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.rects.late?.height).toBe(720);
    expect(p.innerHeight).toBe(1720);
  });
});

describe("widgets that land after the viewport grew", () => {
  it("freezes a <style> inside an added subtree, and an added element with a style attribute", async () => {
    const r = await run("widget");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.rects.w?.height).toBe(720);
    expect(p.rects.w2?.height).toBe(360);
    expect(p.innerHeight).toBe(1720);
  });
});

describe("shadow roots and adopted stylesheets", () => {
  it("reaches open roots, a nested root, a constructed sheet shared by two roots or set on the document, and a <style> added to a root later", async () => {
    const r = await run("shadow");
    expect(r.status, r.out).toBe(0);
    const { rects, innerHeight } = probe(r.dir);
    expect([rects.open, rects.a1, rects.a2, rects.inner, rects.doc].map((rect) => rect?.height)).toEqual([720, 360, 360, 180, 72]);
    expect(innerHeight).toBe(1692);
    expect(rects.sh?.height).toBe(144); // 20vh, in a <style> that a resize handler added to a root already there
  });
});

describe("viewport units written by script after the viewport grew", () => {
  it("freezes an inline style rewritten on an element that was already there, and the text of a <style>", async () => {
    const r = await run("rewrite");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.rects.grow?.height).toBe(720);
    expect(p.rects.c?.height).toBe(360);
    expect(p.innerHeight).toBe(2080);
  });
});

describe("an inline style written alone", () => {
  it("is frozen when it is the only thing that changed", async () => {
    const r = await run("inline");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.rects.grow?.height).toBe(720);
    expect(p.innerHeight).toBe(1720);
  });
});

describe("a document that is scaled", () => {
  it("freezes 100vh at 720 CSS px, the computed height, not at the scaled bounding rect", async () => {
    const r = await run("transform");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.height).toBe("720px");
    expect(p.rects.tall?.height).toBe(360); // what the scale makes of it
  });
});

describe("a value the page wrote again with a new priority", () => {
  it("is the page's own value, not one to freeze again", async () => {
    const r = await run("priority");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts).toEqual({ value: "720px", priority: "" });
    expect(probe(r.dir, "02").facts).toEqual({ value: "720px", priority: "important" });
  });
});

describe("a stylesheet link that is still loading when the freeze begins", () => {
  it("is frozen when it arrives, at the viewport of the shot", async () => {
    const r = await run("slowlink");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.rects.slow?.height).toBe(720);
    expect(p.innerHeight).toBe(1720);
  });
});

describe("a cross-origin stylesheet whose href has a fragment", () => {
  it("is fetched again and frozen, with nothing to warn about", async () => {
    const r = await run("fragment");
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("cannot read");
    expect(noted(r.out)).toEqual([]);
    expect(probe(r.dir).rects.xo?.height).toBe(720);
  });
});

describe("what the freeze keeps and what it reaches", () => {
  let r: Awaited<ReturnType<typeof run>>;
  let cdnBefore: number;
  let appBefore: number;
  beforeAll(async () => {
    cdnBefore = cdn.hits.length;
    appBefore = app.hits.length;
    r = await run("keep");
  });

  it("passes snapPage on a page that needs every kind of declaration frozen", () => {
    expect(r.status, r.out).toBe(0);
    expect(pngSize(join(r.dir, "01.png"))[1]).toBe(probe(r.dir).scrollHeight);
  });

  it("leaves quoted text and url() alone, keeps !important, and turns custom properties and shorthands into px", () => {
    const { facts, rects } = probe(r.dir);
    expect(facts?.before).toBe('"100vh"');
    expect(facts?.background).toContain("/100vh.png");
    expect(app.hits.slice(appBefore)).toContain("/100vh.png"); // requested as written
    expect(facts?.priority).toBe("important");
    expect(facts?.priValue).toBe("720px");
    expect(facts?.custom).toBe("360px");
    expect(rects.cv?.height).toBe(360); // height: var(--h), --h: 50vh
    expect(rects.fb?.height).toBe(720); // min-height: var(--x, 100vh)
    expect(facts?.insetBottom).toBe("72px"); // inset: 0 0 10vh
  });

  it("reaches nested @media, an @import, CSS nesting, inline style and vmin", () => {
    const { rects } = probe(r.dir);
    expect(rects.pri?.height).toBe(720);
    expect(rects.media?.height).toBe(360);
    expect(rects.imp?.height).toBe(180);
    expect(rects.nest?.height).toBe(360);
    expect(rects.inl?.height).toBe(360);
    expect(rects.vmin?.height).toBe(72); // 10vmin of 1280x720, kept after the viewport grew past 1280
  });

  it("freezes a cross-origin sheet through one CORS refetch, and its url() still resolves against the sheet", () => {
    expect(probe(r.dir).rects.xo?.height).toBe(720);
    const hits = cdn.hits.slice(cdnBefore);
    expect(hits.filter((u) => u.startsWith("/style.css"))).toHaveLength(2);
    expect(hits.some((u) => u.startsWith("/img.png"))).toBe(true);
    expect(app.hits.some((u) => u.startsWith("/img.png"))).toBe(false);
  });
});

describe("a sheet that stays unreadable", () => {
  it("is noted on every shot, keeps the original sheet, and is refetched once per document", async () => {
    const before = cdn.hits.length;
    const appBefore = app.hits.length;
    const r = await run("flaky");
    expect(r.status, r.out).toBe(0);
    const note = `cannot read ${cdn.url}/flaky.css: its viewport units stay live`;
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with ${note}  ${app.url}/flaky`, `snapseq: 02.png taken with ${note}  ${app.url}/flaky`]);
    expect(probe(r.dir, "01").rects.flaky?.height).toBe(720); // the original sheet still applies, live
    // The page's, the plugin's one refetch (500, passed on) and the browser's own request after it, all with the full URL.
    expect(cdn.hits.slice(before).filter((u) => u.startsWith("/flaky.css"))).toEqual(Array(3).fill("/flaky.css?sig=abc"));
    expect(noted(r.out).join("\n")).not.toContain("sig=abc"); // the note shows the URL without its query string
    // A route turns the HTTP cache off. The sequence fetched a cacheable file twice before the first shot and twice
    // after the refetch: one request each means no route was there, at the start or once the refetch was done.
    const cached = app.hits.slice(appBefore).filter((u) => u.startsWith("/cached.txt"));
    expect(cached.sort()).toEqual(["/cached.txt?a", "/cached.txt?b"]);
  });
});

describe("sheets the plugin cannot or should not fetch again", () => {
  it("notes a cross-origin @import on its shot, and leaves a sheet the page disabled alone", async () => {
    const before = cdn.hits.length;
    const r = await run("sheets");
    expect(r.status, r.out).toBe(0);
    // The disabled sheet's page says nothing.
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with cannot read ${cdn.url}/style.css: its viewport units stay live  ${app.url}/import`]);
    expect(cdn.hits.slice(before).filter((u) => u.startsWith("/style.css"))).toHaveLength(2); // one request per page
  });
});

describe("a stylesheet that redirects", () => {
  // The browser's request after a redirect we fulfilled does not come back through the route, so no CORS header
  // can reach it: the sheet cannot be made readable. It stays as the page had it, with its url() resolved
  // against where the redirect ends, and the plugin says so.
  it("stays as the page had it, and is noted on the shot", async () => {
    const before = cdn.hits.length;
    const r = await run("redirect");
    expect(r.status, r.out).toBe(0);
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with cannot read ${cdn.url}/old/style.css: its viewport units stay live  ${app.url}/redirect`]);
    expect(probe(r.dir).rects.hero?.height).toBe(720); // the original sheet still applies, live
    const hits = cdn.hits.slice(before);
    expect(hits).toContain("/v1/img.png");
    expect(hits).not.toContain("/old/img.png");
    expect(hits).not.toContain("/img.png");
  });
});

describe("a page that reports a URL of its own as an unreadable stylesheet", () => {
  // The plugin trusts the page's list only to pick the URLs it routes. The route answers a text/css response and nothing
  // else, so the page's own fetch of a JSON file in that window gets no CORS header, and no cookie of the context goes with it.
  it("cannot read it through the plugin's route, and the shot still passes", async () => {
    const before = secretCookies.length;
    const r = await run("hostile");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.leaked).toBe("false");
    expect(secretCookies.length).toBeGreaterThan(before); // the page's link, the plugin's fetch and the browser's own requests reached the server
    expect(secretCookies.slice(before).filter(Boolean)).toEqual([]); // the session cookie it set is never sent back
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with cannot read ${cdn.url}/secret.json: its viewport units stay live  ${app.url}/hostile`]);
  });
});

describe("a stylesheet requested by a frame built by script", () => {
  it("does not hang the sequence", async () => {
    const started = Date.now();
    const r = await run("iframe");
    expect(r.status, r.out).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("a layout that follows the viewport through script", () => {
  it("is still refused with the same text, the viewport is restored, and the next snap works", async () => {
    const withPlugin = await run("follow");
    const without = await run("follow", { NO_STAB: "1" });
    expect(withPlugin.status, withPlugin.out).toBe(0);
    const refused = readFileSync(join(withPlugin.dir, "refused.txt"), "utf8");
    expect(refused).toContain("snapPage: the document grew from 2000 to 4000 px");
    expect(refused).toContain("snap({ fullPage: true })");
    expect(refused).toContain("viewport height 720");
    expect(refused).toBe(readFileSync(join(without.dir, "refused.txt"), "utf8"));
    expect(readdirSync(withPlugin.dir).filter((f) => f.endsWith(".png"))).toEqual(["01.png"]);
  });
});

describe("motion", () => {
  it("makes two consecutive shots byte-identical and leaves animations at their end state", async () => {
    const r = await run("motion");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.running).toBe(0);
    expect(p.infinite).toBe(0);
    expect(p.facts?.fwd).toBe("0.5"); // forwards fill: the end state
    expect(p.facts?.nofill).toBe("1"); // no fill: back to its base
    expect(p.facts?.chain).toBe("90px"); // started by the first one's finish handler
    expect(p.facts?.rm).toBe("rgb(9, 9, 9)"); // the page's own preference: reduced motion is not emulated
    expect(p.facts?.bar).toBe("80"); // a finished SMIL draw-in stays drawn: the SVG is paused, not rewound
    expect(readFileSync(join(r.dir, "01.png")).equals(readFileSync(join(r.dir, "02.png")))).toBe(true);
  });

  it("emulates prefers-reduced-motion: reduce with reducedMotion: true", async () => {
    const r = await run("motion", { STAB: JSON.stringify({ reducedMotion: true }) });
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.rm).toBe("rgb(1, 2, 3)");
  });

  it("finishes an animation that starts after the pass, because the screenshot runs with animations disabled", async () => {
    const r = await run("anim");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.running).toBe(0);
    expect(p.facts?.opacity).toBe("0.5");
  });

  it("is left alone with motion: false: the infinite animation still runs", async () => {
    const r = await run("motion", { STAB: JSON.stringify({ motion: false }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.infinite).toBeGreaterThan(0); // the page's own infinite animation, not one of the finite minute-long ones
    expect(p.facts?.rm).toBe("rgb(9, 9, 9)");
  });
});

describe("hover", () => {
  // The card moved under the pointer when the click inserted the block above it.
  it("moves the pointer off the content: the card under it is not drawn in :hover", async () => {
    const r = await run("hover");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.card).toBe("rgb(10, 20, 30)");
    expect(probe(r.dir).facts?.leftAt).toBe("360"); // out through the left edge at mid-height, not the top, which exit-intent scripts watch
  });

  it("is left alone for a shot with hover: \"keep\", and with hover: false", async () => {
    const keep = await run("hoverkeep");
    expect(keep.status, keep.out).toBe(0);
    expect(probe(keep.dir).facts?.card).toBe("rgb(40, 50, 60)");
    const off = await run("hover", { STAB: JSON.stringify({ hover: false }) });
    expect(off.status, off.out).toBe(0);
    expect(probe(off.dir).facts?.card).toBe("rgb(40, 50, 60)");
  });
});

describe("scroll pass for snap({ fullPage: true })", () => {
  it("reveals the sections and loads the lazy image, and the page ends where it started", async () => {
    const r = await run("reveal", { STAB: JSON.stringify({ scroll: true }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.last).toBe("1");
    expect(p.facts?.src).toBe(`${app.url}/lazy.png`);
    expect(p.facts?.y).toBe("0");
    expect(noted(r.out)).toEqual([]); // no note
  });

  it("starts from the top, not from where the page was scrolled to", async () => {
    const r = await run("revealmid", { STAB: JSON.stringify({ scroll: true }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.mid).toBe("1"); // three screens above the position the sequence left the page at
    expect(p.facts?.last).toBe("1");
    expect(p.facts?.y).toBe("6000");
  });

  it("waits for a page that builds itself after load: its sections are revealed and its image loaded", async () => {
    const r = await run("hydrate", { STAB: JSON.stringify({ scroll: true }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.total).toBe("10");
    expect(p.facts?.revealed).toBe("10");
    expect(p.facts?.src).toBe(`${app.url}/lazy.png`);
  });

  it("is off by default: the last section stays hidden and the image unloaded", async () => {
    const r = await run("reveal");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.last).toBe("0");
    expect(probe(r.dir).facts?.src).toBe("");
  });

  it("is not run for a plain snap", async () => {
    const r = await run("revealsnap", { STAB: JSON.stringify({ scroll: true }) });
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.last).toBe("0");
  });

  it("stops after 60 steps with a note, and still restores the scroll position", async () => {
    const r = await run("long", { STAB: JSON.stringify({ scroll: true }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with scroll pass stopped after 60 steps  ${app.url}/long`]);
    expect(p.facts?.y).toBe("300");
  });
});

describe("entry points", () => {
  it("loads as ESM and as CommonJS", async () => {
    const esm = await import(join(PKG, "dist", "index.js"));
    const cjs = createRequire(import.meta.url)(join(PKG, "dist", "index.cjs"));
    for (const mod of [esm, cjs]) {
      expect(typeof mod.stabilize).toBe("function");
      expect(mod.stabilize().name).toBe("stabilize");
    }
    expect(existsSync(join(PKG, "dist", "index.d.ts"))).toBe(true);
  });
});
