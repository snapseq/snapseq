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

// A same-origin sheet that @imports a cross-origin one, as a font service's is: the import loads without CORS, so its
// rules stay unreadable even though its server sends the header. /fonts.css imports @font-face rules only, /units.css a 50vh.
const sheetImportPage = (sheet: string) =>
  `<!doctype html><html><head><link rel="stylesheet" href="${sheet}"></head><body style="margin:0"><div id="u"></div><div style="height:1000px"></div></body></html>`;

// What the text check of an imported sheet has to read right, served from the CDN with the CORS header. login is a
// stylesheet for the import and a login page for the check's fetch; big is font rules past the 512 K cap. imp... are sheets
// that @import another by a relative URL: beacon is a comment only (a tracking pixel's sheet), vh has a viewport unit, deep
// imports one itself; cap9 and cap10 import nine and ten beacons.
const CHECKED_CSS: Record<string, string> = {
  imp: '@import url("./beacon.css"); .a { color: red }',
  impforms:
    "@import url(\"./beacon.css\"); @import url('./beacon.css?2'); @import url(./beacon.css?3); @import \"./beacon.css?4\" screen; @import './beacon.css?5' layer(x);",
  impvh: '@import url("./vh.css");',
  impdeep: '@import "./deep.css";',
  cap9: Array.from({ length: 9 }, (_, i) => `@import url("./beacon.css?${i + 1}");`).join(""),
  cap10: Array.from({ length: 10 }, (_, i) => `@import url("./beacon.css?${i + 1}");`).join(""),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`par${i + 1}`, `@import url("./beacon.css?p${i + 1}");`])), // six parents, each with a beacon: 12 fetches
  slowimp: '@import url("./beacon.css");',
  beacon: "/* beacon */",
  vh: "#u { height: 100vh }",
  deep: '@import url("./beacon.css");',
  nested: '@import url("/x/font.css");',
  comment: "/* ' */ #u { height: 100vh } /* ' */",
  escape: "#u { height: 100v\\68 }",
  fontcomment: '/* 100vh */ @font-face { font-family: "F"; src: url(/f.woff2) }',
  login: "#u { height: 50vh }",
  big: '@font-face { font-family: "F"; src: url(/f.woff2) }'.repeat(12000),
  font: '@font-face { font-family: "F"; src: url(/f.woff2) }',
};
const importsPage = (hrefs: string[]) =>
  `<!doctype html><html><head><style>${hrefs.map((href) => `@import url("${href}");`).join("")}</style></head><body style="margin:0"><div id="u"></div></body></html>`;

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

// A bar chart whose bars grow in, 0 to 90 %, by a forwards keyframe once an observer marks the chart in view: 1500 px
// down, so only the grown viewport shows it. A spinner turns forever. 20 + 1500 + 100 + 300 = 1920 px tall.
const CHART_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
@keyframes grow { from { width: 0 } to { width: 90% } }
@keyframes spin { to { transform: rotate(1turn) } }
#chart { height: 100px }
.bar { height: 100px; width: 0; background: rgb(255, 128, 0) }
.inView .bar { animation: grow 1s forwards }
#spin { width: 20px; height: 20px; background: #000; animation: spin 1s linear infinite }
</style></head><body><div id="spin"></div><div style="height:1500px"></div><section id="chart"><div class="bar"></div></section><div style="height:300px"></div><script>
new IntersectionObserver((entries, o) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("inView"), o.disconnect()))).observe(document.getElementById("chart"));
</script></body></html>`;

// A section that opens, max-height 0 to 600 px over 2 s, once the page end is in view: only the grown viewport shows
// it, and the page is 600 px taller once it is open. 1500 + 600 + 20 = 2120 px tall then, the green end last.
const OPEN_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
@keyframes open { from { max-height: 0 } to { max-height: 600px } }
#more { max-height: 0; overflow: hidden; background: rgb(0, 128, 255) }
#more.inView { animation: open 2s forwards }
#more > div { height: 600px }
#end { height: 20px; background: rgb(0, 160, 0) }
</style></head><body><div style="height:1500px"></div><section id="more"><div></div></section><div id="end"></div><script>
new IntersectionObserver((entries, o) => entries.forEach((e) => e.isIntersecting && (document.getElementById("more").classList.add("inView"), o.disconnect()))).observe(document.getElementById("end"));
</script></body></html>`;

// A fixed bar at the bottom that hides once the page end is in view, by a scroll handler on the document; one on the
// window notes that it heard the event too. 1500 px tall.
const SCROLLEVENT_PAGE = `<!doctype html><html><body style="margin:0;background:#fff"><div style="height:1500px"></div>
<div id="tray" style="position:fixed;bottom:0;left:0;right:0;height:80px;background:rgb(200, 0, 0)"></div><script>
const tray = document.getElementById("tray");
let heard = "no";
document.addEventListener("scroll", () => {
  tray.style.display = scrollY + innerHeight >= document.documentElement.scrollHeight - 100 ? "none" : "";
});
addEventListener("scroll", () => (heard = "yes"));
window.__facts = () => ({ tray: getComputedStyle(tray).display, heard });
</script></body></html>`;

// A promo drawer: fixed, 325 px up from the bottom of a 1920x1080 viewport (top 497), 258 px tall, with a transform of its
// own. The footer fills the last 600 px of the 4583 px page, which is where the drawer lands when it follows its bottom inset.
const DRAWER_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#filler { height: 3983px; background: rgb(240, 240, 240) }
#footer { height: 600px; background: rgb(10, 120, 10) }
#drawer { position: fixed; bottom: 325px; left: 100px; width: 300px; height: 258px; transform: translateX(0); background: rgb(200, 0, 100) }
</style></head><body><div id="filler"></div><div id="footer"></div><div id="drawer"></div><script>
window.__facts = () => {
  const el = document.getElementById("drawer");
  return { inline: el.style.top + "|" + el.style.bottom, bottom: getComputedStyle(el).bottom, transform: getComputedStyle(el).transform };
};
</script></body></html>`;

// The drawer again, anchored by an inline `bottom: 0 !important` of the page's own, with a page script that writes a top of
// its own once the plugin has pinned it, as the page grows.
const OWN_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#drawer { position: fixed; left: 0; width: 200px; height: 100px; background: rgb(200, 0, 100) }
</style></head><body><div style="height:1500px"></div><div id="drawer" style="bottom: 0 !important"></div><script>
const el = document.getElementById("drawer");
addEventListener("resize", () => {
  if (window.armed) return;
  window.armed = true;
  const timer = setInterval(() => {
    if (el.style.bottom !== "auto") return;
    el.style.top = "24px";
    clearInterval(timer);
  }, 5);
});
window.__facts = () => ({ inline: el.style.top + "|" + el.style.bottom + "|" + el.style.getPropertyPriority("bottom") });
</script></body></html>`;

// Fixed elements the plugin has to leave alone, or move without breaking them, on a 3000 px page at 1280x720: a header
// at the top, a dimmer over everything (behind the page), a panel from 10 % down to the bottom whose height is the
// viewport's, a box centred by top: 50 % and a transform, and one parked below the first screen.
const SHAPES_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#header { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: rgb(255, 0, 0) }
#dimmer { position: fixed; inset: 0; z-index: -1; background: rgb(250, 235, 215) }
#panel { position: fixed; top: 10%; bottom: 0; right: 0; width: 100px; background: rgb(0, 0, 255) }
#centered { position: fixed; top: 50%; left: 200px; width: 100px; height: 100px; transform: translateY(-50%); background: rgb(0, 160, 0) }
#parked { position: fixed; bottom: -100%; left: 400px; width: 100px; height: 100px; background: rgb(255, 0, 255) }
</style></head><body><div style="height:3000px"></div><div id="header"></div><div id="dimmer"></div><div id="panel"></div><div id="centered"></div><div id="parked"></div><script>
const inline = (id) => document.getElementById(id).style.top + "|" + document.getElementById(id).style.bottom;
window.__facts = () => ({
  header: inline("header"),
  dimmer: inline("dimmer"),
  panel: inline("panel"),
  centered: inline("centered"),
  parked: inline("parked"),
  transform: getComputedStyle(document.getElementById("centered")).transform,
});
</script></body></html>`;

// A fixed child in a fixed ancestor that is scaled: the ancestor is the child's containing block.
const SCALED_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#parent { position: fixed; bottom: 0; left: 0; width: 400px; height: 200px; transform: scale(0.5); background: rgb(0, 0, 200) }
#child { position: fixed; top: 20px; left: 20px; width: 100px; height: 100px; background: rgb(255, 200, 0) }
</style></head><body><div style="height:2000px"></div><div id="parent"><div id="child"></div></div><script>
const inline = (id) => document.getElementById(id).style.top + "|" + document.getElementById(id).style.bottom;
window.__facts = () => ({ parent: inline("parent"), child: inline("child") });
</script></body></html>`;

// A fixed box in an open shadow root.
const SHADOWFLOAT_PAGE = `<!doctype html><html><body style="margin:0"><div style="height:2000px"></div><x-box></x-box><script>
customElements.define("x-box", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<div id="inshadow" style="position:fixed;bottom:0;left:0;width:200px;height:100px;background:rgb(0,150,150)"></div>';
  }
});
window.__facts = () => ({ inline: document.querySelector("x-box").shadowRoot.getElementById("inshadow").style.top });
</script></body></html>`;

// The page is taller once the first grow landed, so there is a second grow, and the drawer hides in it. #stay is still there.
const REGROW_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#drawer { position: fixed; bottom: 0; left: 0; width: 200px; height: 100px; background: rgb(200, 0, 100) }
#stay { position: fixed; bottom: 0; right: 0; width: 100px; height: 100px; background: rgb(0, 0, 200) }
</style></head><body><div style="height:1000px"></div><div id="more"></div><div id="drawer"></div><div id="stay"></div><script>
let resizes = 0;
addEventListener("resize", () => {
  resizes++;
  if (resizes === 1) document.getElementById("more").style.height = "500px";
  if (resizes === 2) document.getElementById("drawer").style.display = "none";
});
const inline = (id) => document.getElementById(id).style.top + "|" + document.getElementById(id).style.bottom;
window.__facts = () => ({ drawer: inline("drawer"), stay: inline("stay") });
</script></body></html>`;

// A drawer whose inline bottom is a viewport unit: the freeze keeps the page's value for the next shot's viewport.
const VHDRAWER_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#drawer { position: fixed; left: 0; width: 200px; height: 100px; background: rgb(200, 0, 100) }
</style></head><body><div style="height:2000px"></div><div id="drawer" style="bottom: 10vh"></div><script>
window.__facts = () => ({ inline: document.getElementById("drawer").style.bottom, bottom: getComputedStyle(document.getElementById("drawer")).bottom });
</script></body></html>`;

// Two trays the page moves out of view once the page end is in view, by rules on <body> (so neither tray's own class or
// inline style changes): one slides out by a transform, one drops below the viewport by its bottom inset.
const TRAYS_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#slide { position: fixed; bottom: 0; left: 0; width: 200px; height: 80px; background: rgb(200, 0, 0) }
#drop { position: fixed; bottom: 0; left: 300px; width: 200px; height: 80px; background: rgb(0, 0, 200) }
.end #slide { transform: translateY(100%) }
.end #drop { bottom: -80px }
</style></head><body><div style="height:1500px"></div><div id="slide"></div><div id="drop"></div><script>
document.addEventListener("scroll", () => document.body.classList.toggle("end", scrollY + innerHeight >= document.documentElement.scrollHeight - 100));
const inline = (id) => document.getElementById(id).style.top + "|" + document.getElementById(id).style.bottom;
window.__facts = () => ({ slide: inline("slide"), drop: inline("drop") });
</script></body></html>`;

// A menu the page keeps under its trigger, by an inline top it writes on scroll and resize (what a positioning library does
// with a fixed strategy). The trigger is 400 px down; the sequence scrolls to 300 first, so the grown viewport moves the menu.
const ANCHORED_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#trigger { position: absolute; top: 400px; left: 100px; width: 200px; height: 30px; background: rgb(0, 120, 0) }
#menu { position: fixed; left: 100px; width: 200px; height: 100px; background: rgb(200, 0, 100) }
</style></head><body><div style="height:3000px"></div><div id="trigger"></div><div id="menu"></div><script>
const place = () => { document.getElementById("menu").style.top = document.getElementById("trigger").getBoundingClientRect().bottom + "px"; };
addEventListener("scroll", place);
addEventListener("resize", place);
place();
window.__facts = () => {
  const s = document.getElementById("menu").style;
  return { top: s.top, priority: s.getPropertyPriority("top"), bottom: s.bottom };
};
</script></body></html>`;

// A bottom sheet that peeks 60 px at the device viewport (top 660 of 720, 400 px tall).
const SHEET_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#sheet { position: fixed; bottom: 0; left: 0; width: 400px; height: 400px; transform: translateY(340px); background: rgb(200, 0, 100) }
</style></head><body><div style="height:1500px"></div><div id="sheet"></div><script>
window.__facts = () => ({ inline: document.getElementById("sheet").style.top + "|" + document.getElementById("sheet").style.bottom });
</script></body></html>`;

// The REGROW page, but the page clears the plugin's top in the second grow, before the plugin looks at the element again.
const TAKEN_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#drawer { position: fixed; bottom: 0; left: 0; width: 200px; height: 100px; background: rgb(200, 0, 100) }
</style></head><body><div style="height:1000px"></div><div id="more"></div><div id="drawer"></div><script>
let resizes = 0;
addEventListener("resize", () => {
  resizes++;
  const el = document.getElementById("drawer");
  if (resizes === 1) document.getElementById("more").style.height = "500px";
  if (resizes === 2 && el.style.bottom === "auto") el.style.removeProperty("top");
});
window.__facts = () => ({ inline: document.getElementById("drawer").style.top + "|" + document.getElementById("drawer").style.bottom });
</script></body></html>`;

// FOLLOW_PAGE with a drawer: the shot is refused after the plugin pinned it.
const FOLLOWDRAWER_PAGE = `<!doctype html><html><head><style>
body { margin: 0 }
#drawer { position: fixed; bottom: 0; left: 0; width: 200px; height: 100px; background: rgb(200, 0, 100) }
</style></head><body><div style="height:1000px"></div><div id="drawer"></div><script>
addEventListener("resize", () => { document.body.style.height = innerHeight * 2 + "px"; });
window.__facts = () => ({ inline: document.getElementById("drawer").style.top + "|" + document.getElementById("drawer").style.bottom });
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
// viewport grown, the geometry of every element with an id, inside open shadow roots too. The plugin hands the page's own
// insets back in afterRestore, after every afterSnap, so the probe sees the page as the screenshot did wherever it is listed. STAB is the plugin's options as JSON; NO_STAB leaves it out.
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
  plugins: process.env.NO_STAB ? [probe()] : [probe(), stabilize(JSON.parse(process.env.STAB ?? "{}"))],
});
`;

// snapPage, then what the page holds once it returned (the viewport restored, the shot's hooks done), then a plain snap.
const floatSequence = (path: string, before = "") => `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {${before}
  await page.goto("${path}");
  await seq.snapPage();
  writeFileSync(join(seq.dir, "after.json"), JSON.stringify(await page.evaluate(() => window.__facts())));
  await seq.snap();
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
  checked: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/checked");
  await seq.snap();
  await page.goto("/many");
  await seq.snap();
  await seq.snap();
});
`,
  imports: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/fontimport");
  await seq.snap();
  await page.goto("/unitimport");
  await seq.snap();
  await seq.snap();
});
`,
  importchain: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  for (const path of ["/nestedimports", "/importforms", "/importcap9", "/importcap10"]) {
    await page.goto(path);
    await seq.snap();
  }
  await seq.snap();
});
`,
  importab: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/importab");
  await seq.snap();
  await seq.snap();
});
`,
  importbudget: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/importbudget");
  await seq.snap();
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
  chart: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/chart");
  await seq.snapPage();
});
`,
  open: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/open");
  await seq.snapPage();
});
`,
  scrollevent: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/scrollevent");
  await seq.snapPage();
  await seq.snap();
});
`,
  // A click on the tray right after snapPage, before any other shot: it waits for the tray to be visible, and gives up after 3 s.
  restored: `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/scrollevent");
  await seq.snapPage();
  writeFileSync(join(seq.dir, "after.json"), JSON.stringify(await page.evaluate(() => window.__facts())));
  await page.locator("#tray").click({ timeout: 3000 });
});
`,
  drawer: floatSequence("/drawer", "\n  await page.setViewportSize({ width: 1920, height: 1080 });"),
  own: floatSequence("/own"),
  shapes: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/shapes");
  await seq.snapPage();
});
`,
  scaled: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/scaled");
  await seq.snapPage();
});
`,
  shadowfloat: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/shadowfloat");
  await seq.snapPage();
});
`,
  regrow: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/regrow");
  await seq.snapPage();
});
`,
  trays: floatSequence("/trays"),
  anchored: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/anchored");
  await page.evaluate(() => window.scrollTo(0, 300));
  await seq.snapPage();
});
`,
  sheet: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/sheet");
  await seq.snapPage();
});
`,
  taken: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/taken");
  await seq.snapPage();
});
`,
  vhdrawer: `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/vhdrawer");
  await seq.snapPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await seq.snap();
});
`,
  followdrawer: `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/followdrawer");
  const refused = await seq.snapPage().then(() => false, () => true);
  writeFileSync(join(seq.dir, "after.json"), JSON.stringify({ refused, ...(await page.evaluate(() => window.__facts())) }));
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
    // Imported, with the CORS header a font service sends; the font's URL looks like a viewport unit.
    else if (url.startsWith("/fonts.css") || url.startsWith("/units.css")) {
      res.writeHead(200, { "content-type": "text/css", "access-control-allow-origin": "*" });
      res.end(url.startsWith("/fonts.css") ? '@font-face { font-family: "F"; src: url(/f-100vh.woff2) format("woff2") }' : "#u { height: 50vh }");
    }
    else if (url.startsWith("/x/")) {
      const name = url.slice(3).split(".")[0]!;
      const sheet = name !== "login" || req.headers.accept?.startsWith("text/css"); // the import asks for a stylesheet, a fetch for */*
      // slow...: answers late, so the sheets beside it are read first.
      setTimeout(() => {
        res.writeHead(200, { "content-type": sheet ? "text/css" : "text/html", "access-control-allow-origin": "*" });
        res.end(sheet ? CHECKED_CSS[name] : "<html><body>Sign in</body></html>");
      }, name.startsWith("slow") ? 300 : 0);
    } else if (url.startsWith("/img.png") || url.startsWith("/v1/img.png")) send(res, "image/png", PNG_1x1);
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
    "/fontimport": sheetImportPage("/fonts.css"),
    "/checked": importsPage(["nested", "comment", "escape", "fontcomment", "login", "big"].map((name) => `${cdn}/x/${name}.css`)),
    "/nestedimports": importsPage(["imp", "impvh", "impdeep"].map((name) => `${cdn}/x/${name}.css`)),
    "/importforms": importsPage([`${cdn}/x/impforms.css`]),
    "/importcap9": importsPage([`${cdn}/x/cap9.css`]),
    "/importbudget": importsPage(Array.from({ length: 6 }, (_, i) => `${cdn}/x/par${i + 1}.css`)),
    "/importab": importsPage([`${cdn}/x/cap9.css`, `${cdn}/x/slowimp.css`]),
    "/importcap10": importsPage([`${cdn}/x/cap10.css`]),
    "/many": importsPage(Array.from({ length: 12 }, (_, i) => `${cdn}/x/font.css?${i + 1}`)),
    "/unitimport": sheetImportPage("/units.css"),
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
    "/chart": CHART_PAGE,
    "/open": OPEN_PAGE,
    "/scrollevent": SCROLLEVENT_PAGE,
    "/drawer": DRAWER_PAGE,
    "/own": OWN_PAGE,
    "/shapes": SHAPES_PAGE,
    "/scaled": SCALED_PAGE,
    "/shadowfloat": SHADOWFLOAT_PAGE,
    "/regrow": REGROW_PAGE,
    "/followdrawer": FOLLOWDRAWER_PAGE,
    "/vhdrawer": VHDRAWER_PAGE,
    "/trays": TRAYS_PAGE,
    "/anchored": ANCHORED_PAGE,
    "/sheet": SHEET_PAGE,
    "/taken": TAKEN_PAGE,
    "/hover": HOVER_PAGE,
    "/reveal": REVEAL_PAGE,
    "/hydrate": HYDRATE_PAGE,
    "/long": LONG_PAGE,
  };
  return startServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const page = pages[path];
    if (path === "/imported.css") send(res, "text/css", "#imp { height: 25vh }");
    else if (path === "/fonts.css" || path === "/units.css") send(res, "text/css", `@import url("${cdn}${path}");`);
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
// What the sequence read from the page right after snapPage returned.
const after = (dir: string): Record<string, string | boolean> => JSON.parse(readFileSync(join(dir, "after.json"), "utf8"));
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
    expect(p.rects.banner?.bottom).toBe(720); // fixed: back where the first screen had it, not at the document end
    expect(pngSize(join(dir, "01.png"))).toEqual([1280, 3960]);

    const img = await image(join(dir, "01.png"));
    for (const y of [0, 30, 59]) expect(img.at(640, y)).toEqual([255, 0, 0]); // the fixed header
    for (const y of [640, 680, 719]) expect(img.at(640, y)).toEqual([0, 0, 255]); // the fixed banner
    for (const y of [3880, 3920, 3959]) expect(img.at(640, y)).toEqual([238, 238, 238]); // the page end, free of it
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
    // The page's, the plugin's one refetch (500, passed on), the browser's own request after it and the one check of its
    // text (500 again), all with the full URL.
    expect(cdn.hits.slice(before).filter((u) => u.startsWith("/flaky.css"))).toEqual(Array(4).fill("/flaky.css?sig=abc"));
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
    // The import's and the check of its text (no CORS header: still noted), then the disabled sheet's.
    expect(cdn.hits.slice(before).filter((u) => u.startsWith("/style.css"))).toHaveLength(3);
  });
});

describe("a cross-origin sheet that a same-origin sheet imports", () => {
  it("is noted only when its text has a viewport unit, and its text is fetched once per document", async () => {
    const before = cdn.hits.length;
    const r = await run("imports");
    expect(r.status, r.out).toBe(0);
    const note = `cannot read ${cdn.url}/units.css: its viewport units stay live  ${app.url}/unitimport`;
    expect(noted(r.out)).toEqual([`snapseq: 02.png taken with ${note}`, `snapseq: 03.png taken with ${note}`]);
    const hits = cdn.hits.slice(before);
    expect(hits.filter((u) => u.startsWith("/fonts.css"))).toHaveLength(2); // the import's, the check's
    expect(hits.filter((u) => u.startsWith("/units.css"))).toHaveLength(2); // two shots, one check
  });
});

describe("the text check of an imported sheet", () => {
  // nested: its @import of a font-only sheet is followed, one level down. comment: quotes inside comments. escape: 100v\68 is 100vh. login: the
  // check's fetch gets HTML, not the sheet the page applied. big: past the cap. fontcomment: a unit in a comment only.
  // many: twelve font-only imports, ten checked per shot; the two not checked yet keep the note until the next shot.
  it("keeps the note for what it cannot rule out, and checks at most ten sheets a shot", async () => {
    const r = await run("checked");
    expect(r.status, r.out).toBe(0);
    const note = (name: string) => `cannot read ${cdn.url}/x/${name}.css: its viewport units stay live`;
    expect(noted(r.out)).toEqual([
      `snapseq: 01.png taken with ${["comment", "escape", "login", "big"].map(note).join(", ")}  ${app.url}/checked`,
      `snapseq: 02.png taken with ${note("font")}  ${app.url}/many`, // the URL without its query: the two notes are one
    ]);
  });
});

describe("the text check, one @import level down", () => {
  // imp: an import of a beacon sheet (a comment) and a harmless rule. impvh: of a sheet with a viewport unit. impdeep: of a
  // sheet that imports a third. impforms: every spelling of an @import, with media and layer text after some. cap9 and cap10:
  // nine and ten imports, which with the sheet itself are ten and eleven fetches against a limit of ten.
  it("drops the note for sheets whose imports are harmless, and keeps it for a viewport unit, a deeper import and an import over the limit, which is not tried again", async () => {
    const before = cdn.hits.length;
    const r = await run("importchain");
    expect(r.status, r.out).toBe(0);
    const note = (name: string) => `cannot read ${cdn.url}/x/${name}.css: its viewport units stay live`;
    expect(noted(r.out)).toEqual([
      `snapseq: 01.png taken with ${["impvh", "impdeep"].map(note).join(", ")}  ${app.url}/nestedimports`,
      `snapseq: 04.png taken with ${note("cap10")}  ${app.url}/importcap10`,
      `snapseq: 05.png taken with ${note("cap10")}  ${app.url}/importcap10`, // a second shot of the same page
    ]);
    // Ten imports can never fit with the sheet itself: answered at once, its text fetched once (and the browser's own load of it).
    expect(cdn.hits.slice(before).filter((u) => u.startsWith("/x/cap10.css"))).toHaveLength(2);
  });

  // cap9 has nine imports and slowimp one, which answers late: after the two sheets 8 of the 10 are left, so cap9 (9 > 8)
  // spends nothing and waits, and slowimp is answered at once, whichever is read first. The next shot has the budget for cap9.
  it("answers the sheet whose imports fit when another's do not, and the other on the next shot", async () => {
    const r = await run("importab");
    expect(r.status, r.out).toBe(0);
    expect(noted(r.out)).toEqual([`snapseq: 01.png taken with cannot read ${cdn.url}/x/cap9.css: its viewport units stay live  ${app.url}/importab`]);
  });
});

describe("the text check when the ten sheets of a shot run out", () => {
  // Six sheets that each import a beacon are twelve fetches: the six come first, so four imports get a slot and two do not.
  // Their parents are not recorded as unreadable, and the next shot tries them again.
  it("notes the two sheets it could not finish on the first shot, and tries them again on the second", async () => {
    const r = await run("importbudget");
    expect(r.status, r.out).toBe(0);
    const lines = noted(r.out);
    expect(lines).toHaveLength(1); // the first shot only
    expect(lines[0]).toContain("snapseq: 01.png");
    expect(lines[0]!.match(/cannot read/g)).toHaveLength(2);
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

describe("motion after snapPage grows the viewport", () => {
  // Not removed by CSS, as snapseq's disableTransitions does, so the reveal the grow started is finished at its end.
  it("shows a forwards reveal the grow started at its end state, and cancels an infinite animation", async () => {
    const r = await run("chart");
    expect(r.status, r.out).toBe(0);
    expect(pngSize(join(r.dir, "01.png"))).toEqual([1280, 1920]);
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(1100, 1570)).toEqual([255, 128, 0]); // inside 90 % of 1280 px
    expect(img.at(1200, 1570)).toEqual([255, 255, 255]); // past it
    const p = probe(r.dir);
    expect(p.running).toBe(0);
    expect(p.infinite).toBe(0);
  });

  // A height animation that runs on while snapPage measures would leave the shot cut off, or refused.
  it("finishes a height animation the grow started before snapPage measures, so the page end is in the shot", async () => {
    const r = await run("open");
    expect(r.status, r.out).toBe(0);
    expect(pngSize(join(r.dir, "01.png"))).toEqual([1280, 2120]);
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(640, 1800)).toEqual([0, 128, 255]); // the section, open
    expect(img.at(640, 2119)).toEqual([0, 160, 0]); // the end
  });
});

describe("scrollEvent", () => {
  it("is on by default: a scroll event fires once snapPage grew the viewport, and again once it is restored: the tray hides, then shows", async () => {
    const r = await run("scrollevent");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts).toEqual({ tray: "none", heard: "yes" }); // at the document, bubbling to the window
    const full = await image(join(r.dir, "01.png"));
    expect(full.at(640, 1499)).toEqual([255, 255, 255]); // not at the page end
    expect(full.at(640, 719)).toEqual([255, 255, 255]); // and not pinned at the first screen either: it is gone
    expect(probe(r.dir, "02").facts?.tray).toBe("block"); // back at one screen from the top
    expect((await image(join(r.dir, "02.png"))).at(640, 719)).toEqual([200, 0, 0]);
  });

  it("shows the tray again as soon as snapPage returns, before any other shot: a click on it between shots finds it", async () => {
    const r = await run("restored");
    expect(r.status, r.out).toBe(0); // the click would time out on a tray left hidden by the grown viewport
    expect(probe(r.dir, "01").facts?.tray).toBe("none"); // hidden while the shot was taken
    expect(after(r.dir)).toEqual({ tray: "block", heard: "yes" });
  });

  it("with scrollEvent: false no scroll event fires on the grow: the tray stays, where the first screen had it", async () => {
    const r = await run("scrollevent", { STAB: JSON.stringify({ scrollEvent: false }) });
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts).toEqual({ tray: "block", heard: "no" });
    const full = await image(join(r.dir, "01.png"));
    expect(full.at(640, 719)).toEqual([200, 0, 0]);
    expect(full.at(640, 1499)).toEqual([255, 255, 255]);
  });
});

describe("floating", () => {
  describe("a drawer anchored by its bottom inset", () => {
    let r: Awaited<ReturnType<typeof run>>;
    beforeAll(async () => {
      r = await run("drawer");
    });

    it("sits at the top it had on the first screen, not at the page end, with its width, height and transform unchanged", async () => {
      expect(r.status, r.out).toBe(0);
      expect(pngSize(join(r.dir, "01.png"))).toEqual([1920, 4583]);
      const p = probe(r.dir, "01");
      expect(p.rects.drawer).toMatchObject({ top: 497, width: 300, height: 258 });
      expect(p.facts?.inline).toBe("497px|auto"); // what the plugin wrote while the shot was taken
      expect(p.facts?.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
      const img = await image(join(r.dir, "01.png"));
      expect(img.at(150, 496)).toEqual([240, 240, 240]);
      expect(img.at(150, 497)).toEqual([200, 0, 100]);
      expect(img.at(150, 754)).toEqual([200, 0, 100]);
      expect(img.at(150, 755)).toEqual([240, 240, 240]);
      expect(img.at(99, 600)).toEqual([240, 240, 240]);
      expect(img.at(100, 600)).toEqual([200, 0, 100]);
      expect(img.at(399, 600)).toEqual([200, 0, 100]);
      expect(img.at(400, 600)).toEqual([240, 240, 240]);
      for (const y of [4001, 4100, 4257]) expect(img.at(150, y)).toEqual([10, 120, 10]); // the footer, where the drawer used to be
    });

    it("hands the page's insets back once the shot is taken, so the next snap shows it bottom-anchored with no inline top or bottom", () => {
      // Read in the sequence right after snapPage returned, then by the probe on the plain snap.
      expect(after(r.dir).inline).toBe("|");
      expect(after(r.dir).bottom).toBe("325px");
      const p = probe(r.dir, "02");
      expect(p.facts).toMatchObject({ inline: "|", bottom: "325px", transform: "matrix(1, 0, 0, 1, 0, 0)" });
      expect(p.rects.drawer).toMatchObject({ top: 497, height: 258 });
    });
  });

  it("with floating: false leaves the drawer at the page end", async () => {
    const r = await run("drawer", { STAB: JSON.stringify({ floating: false }) });
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir, "01");
    expect(p.rects.drawer?.top).toBe(4000);
    expect(p.facts?.inline).toBe("|");
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(150, 4100)).toEqual([200, 0, 100]);
    expect(img.at(150, 600)).toEqual([240, 240, 240]);
  });

  it("leaves a value the page wrote itself while the page was grown, takes back only its own, and returns the page's inline bottom with its priority", async () => {
    const r = await run("own");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts?.inline).toBe("24px|auto|important"); // the page's write landed after the pin, before the shot ended
    expect(after(r.dir).inline).toBe("24px|0px|important"); // the page's top stays, its bottom is back
  });

  it("leaves a header, a dimmer, a stretched panel and a parked box alone, and centres a transformed box once", async () => {
    const r = await run("shapes");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts).toMatchObject({
      header: "|", // already at its first-screen top
      dimmer: "|",
      panel: "|", // its height follows the viewport: rolled back or skipped, with its own layout
      centered: "360px|auto",
      parked: "|", // never recorded: it was below the first screen
      transform: "matrix(1, 0, 0, 1, 0, -50)", // applied once
    });
    expect(p.rects.header).toMatchObject({ top: 0, height: 40 });
    expect(p.rects.dimmer?.height).toBe(3000);
    expect(p.rects.panel).toMatchObject({ top: 300, height: 2700 });
    expect(p.rects.centered?.top).toBe(310);
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(640, 20)).toEqual([255, 0, 0]);
    expect(img.at(640, 2990)).toEqual([250, 235, 215]); // the dimmer covers the whole page
    expect(img.at(1230, 2990)).toEqual([0, 0, 255]); // the panel runs to the page end
    expect(img.at(250, 309)).toEqual([250, 235, 215]);
    expect(img.at(250, 310)).toEqual([0, 160, 0]);
    expect(img.at(250, 409)).toEqual([0, 160, 0]);
    expect(img.at(250, 410)).toEqual([250, 235, 215]);
    expect(img.at(450, 1390)).toEqual([250, 235, 215]); // where the parked box would be if it were pulled in
  });

  it("moves a fixed child with its scaled fixed ancestor, and gives the child no top of its own", async () => {
    const r = await run("scaled");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts).toEqual({ parent: "520px|auto", child: "|" });
    expect(p.rects.parent?.top).toBe(570);
    expect(p.rects.child?.top).toBe(580);
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(290, 660)).toEqual([0, 0, 200]);
    expect(img.at(135, 600)).toEqual([255, 200, 0]);
    expect(img.at(135, 1900)).toEqual([255, 255, 255]);
  });

  it("leaves the page's viewport-unit inline bottom to be frozen again at the next shot's viewport", async () => {
    const r = await run("vhdrawer");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts?.inline).toBe("auto"); // pinned while the shot was taken
    expect(probe(r.dir, "02").facts?.bottom).toBe("90px"); // 10vh of 900, not the 72 px of the first viewport
  });

  it("does not pull back a tray the page moved out of view, by a transform or by its bottom inset", async () => {
    const r = await run("trays");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir, "01").facts).toEqual({ slide: "|", drop: "|" });
    const full = await image(join(r.dir, "01.png"));
    for (const [x, y] of [[100, 700], [400, 700], [100, 1499], [400, 1499]] as const) expect(full.at(x, y)).toEqual([255, 255, 255]);
    const snap = await image(join(r.dir, "02.png")); // the same trays at the device viewport: they were there to be pinned
    expect(snap.at(100, 719)).toEqual([200, 0, 0]);
    expect(snap.at(400, 719)).toEqual([0, 0, 200]);
  });

  it("leaves a menu the page placed itself at the grown viewport where the page put it", async () => {
    const r = await run("anchored");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts).toEqual({ top: "430px", priority: "", bottom: "" });
    expect(p.rects.menu?.top).toBe(430); // under its trigger, not 300 px up where the first screen had it
    expect((await image(join(r.dir, "01.png"))).at(150, 480)).toEqual([200, 0, 100]);
  });

  it("leaves a bottom sheet that peeked at the device viewport as clipped as it was", async () => {
    const r = await run("sheet");
    expect(r.status, r.out).toBe(0);
    expect(probe(r.dir).facts?.inline).toBe("|");
    const img = await image(join(r.dir, "01.png"));
    for (const y of [100, 660, 1000, 1439]) expect(img.at(200, y)).toEqual([255, 255, 255]);
    expect(img.at(200, 1470)).toEqual([200, 0, 100]); // the last 60 px of the page
  });

  it("does not pin again an element whose top the page cleared between two grows", async () => {
    const r = await run("taken");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.inline).toBe("|");
    expect(p.rects.drawer?.top).toBe(1400);
  });

  it("pins a fixed box in an open shadow root like one in the document", async () => {
    const r = await run("shadowfloat");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.facts?.inline).toBe("620px");
    expect(p.rects.inshadow?.top).toBe(620);
    const img = await image(join(r.dir, "01.png"));
    expect(img.at(100, 650)).toEqual([0, 150, 150]);
    expect(img.at(100, 1950)).toEqual([255, 255, 255]);
  });

  it("pins again after a second grow, and leaves no override on a drawer that hid in it", async () => {
    const r = await run("regrow");
    expect(r.status, r.out).toBe(0);
    const p = probe(r.dir);
    expect(p.scrollHeight).toBe(1500); // the second grow happened
    expect(p.facts).toEqual({ drawer: "|", stay: "620px|auto" });
    expect(p.rects.stay?.top).toBe(620);
  });

  it("takes the pin off when the viewport is restored, even for a refused snapPage, before any other shot", async () => {
    const r = await run("followdrawer");
    expect(r.status, r.out).toBe(0);
    expect(after(r.dir)).toEqual({ refused: true, inline: "|" }); // read right after the refusal
    expect(probe(r.dir, "01").facts?.inline).toBe("|");
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
