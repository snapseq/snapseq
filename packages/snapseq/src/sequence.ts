import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Page, PageScreenshotOptions } from "@playwright/test";
import type { SequenceContext } from "./fixtures.js";
import type { Plugin, Shot } from "./plugin.js";

/**
 * Playwright's screenshot options minus what the sequence owns: the numbered
 * path, and the type and quality from the config's `format`. An interface, so
 * a plugin can add its own keys: `declare module "snapseq" { interface SnapOptions { label?: string } }`.
 * Playwright ignores the keys it does not know, so they reach the screenshot harmlessly.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SnapOptions extends Omit<PageScreenshotOptions, "path" | "type" | "quality"> {}

/** Playwright's screenshot type and quality, as the config's `format`; Playwright validates them at the first shot. */
export type ShotFormat = Pick<PageScreenshotOptions, "type" | "quality">;

export interface Sequence {
  /**
   * Viewport screenshot once the page is ready: the document parsed, the DOM
   * quiet, fonts in and the images in view loaded. Resolves to the file path.
   * `{ fullPage: true }` is Playwright's native full page, which waits for
   * every image: the viewport stays as it is, so sticky and fixed elements
   * come out pinned where the current scroll left them.
   */
  snap(options?: SnapOptions): Promise<string>;
  /**
   * The whole page as a reviewer expects it: the viewport grows to the
   * document height, so sticky and fixed elements rest in flow and anything
   * that reacts to its slot coming into view (a tray that lands) gets to; a
   * scroll event fires, for UI that follows the scroll; the page gets ready;
   * one shot; the viewport and the scroll position are restored, with another
   * scroll event. A layout that follows the viewport height (`vh` units, a loader
   * at the page end) grows with every resize and is refused: use
   * `snap({ fullPage: true })` for those.
   */
  snapPage(options?: Omit<SnapOptions, "fullPage">): Promise<string>;
  /** Directory the screenshots are written to. */
  readonly dir: string;
  /** Every shot listed so far, in order: each one's plugin `afterSnap` hooks passed. */
  readonly shots: readonly Shot[];
}

const documentHeight = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollHeight);

// checkVisibility() options under both names, Chromium's and the spec's (a browser ignores the ones it does not
// know). VISIBLE: visibility: hidden is not. SHOWN: nor is opacity: 0, which also hides an image that fades in
// once loaded (lazysizes, an onLoad class), so it only decides what counts as broken or as the page's scroller.
const VISIBLE = { checkVisibilityCSS: true, visibilityProperty: true };
const SHOWN = { ...VISIBLE, checkOpacity: true, opacityProperty: true };

// ponytail: quiet-DOM heuristic (no mutation for 200 ms, 3 s cap), then two
// frames so the result is painted. Every shot waits for it, so JS-driven motion
// that touches the DOM each frame (a carousel spring, a chart growing) ends
// before the shot. It sees nothing but DOM mutations in this document: a state
// that lands slower, or arrives over video, canvas or an iframe, needs an
// explicit wait before the shot. Resolves true when the DOM went quiet; when
// the cap released it, the element with the most mutation records, so the note
// can name it ("" if none was counted). A text node counts for its parent; the
// Map is capped, as a page that never quiets can add elements without end.
async function settle(page: Page): Promise<true | string> {
  return page.evaluate(
    ({ quietMs, maxMs }) =>
      new Promise<true | string>((resolve) => {
        const counts = new Map<Element, number>();
        const observer = new MutationObserver((records) => {
          for (const { target } of records) {
            const el = target instanceof Element ? target : target.parentElement;
            if (el && (counts.has(el) || counts.size < 500)) counts.set(el, (counts.get(el) ?? 0) + 1);
          }
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(true);
          }, quietMs);
        });
        let timer = window.setTimeout(() => {
          observer.disconnect();
          resolve(true);
        }, quietMs);
        window.setTimeout(() => {
          observer.disconnect();
          let most: Element | undefined;
          for (const [el, n] of counts) if (!most || n > (counts.get(most) ?? 0)) most = el;
          resolve(most ? most.localName + (most.id ? `#${most.id}` : "") + (most.classList[0] ? `.${most.classList[0]}` : "") : "");
        }, maxMs);
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }).then(
        (quiet) =>
          new Promise<true | string>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(quiet))),
          ),
      ),
    { quietMs: 200, maxMs: 3000 },
  );
}

// A face that arrives late changes every line's metrics, so a height measured
// before it is wrong. The screenshot itself waits for fonts, but by then
// snapPage has fixed the viewport. Nothing to wait for when no font is loading:
// `fonts.ready` resolves only at the load event, so a slow image on a page
// without web fonts would otherwise pass for a slow font. Resolves false when
// the cap released it.
async function loadFonts(page: Page): Promise<boolean> {
  return page.evaluate(
    (maxMs) =>
      document.fonts.status === "loaded" ||
      Promise.race([
        document.fonts.ready.then(() => true),
        new Promise<boolean>((done) => window.setTimeout(() => done(false), maxMs)),
      ]),
    5000,
  );
}

// The <img> elements the shot shows: with `all` (a full page) every one, lazy
// ones made eager so they start at all (a native full page never scrolls them
// into view); otherwise the shown ones in the viewport, or in the clip
// (Playwright takes it in viewport coordinates for a viewport shot), and above
// it, so images below the fold do not hold a viewport shot to the cap, nor ones
// an ancestor's overflow box cuts out (below a panel's visible scroll area). They get
// to load, or fail;
// rescanned whenever one settles, until nothing is pending, because a load
// handler can start another image (a placeholder swapping in the real one) and
// a stalled one must not hide it; then decoded. 5 s at most for the lot, and a
// stalled one is waited for again on the next shot. Resolves to how many were
// still pending at the cap and how many failed, each with the first one's URL.
// CSS backgrounds, iframes and shadow trees are not seen. No named inner
// functions: bundlers wrap those in a helper the page does not have.
async function loadImages(
  page: Page,
  all: boolean,
  clip: SnapOptions["clip"],
): Promise<{ pending: number; first: string; failed: number; firstFailed: string }> {
  return page.evaluate(async ({ all, clip, visible, shown, maxMs }) => {
    const deadline = performance.now() + maxMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    let timer = 0;
    const capped = new Promise<void>((done) => (timer = window.setTimeout(done, remaining())));
    // The clip within the viewport, as Playwright cuts it.
    const c = clip ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const [left, right] = [Math.max(c.x, 0), Math.min(c.x + c.width, innerWidth)];
    const bottom = Math.min(c.y + c.height, innerHeight);
    // html's overflow is the viewport's, and so is body's while html's is visible: the walk stops there, so an
    // image above the viewport still counts.
    const html = getComputedStyle(document.documentElement);
    const stop = html.overflowX === "visible" && html.overflowY === "visible" ? document.body : document.documentElement;
    // The image's box cut down, per axis, by each overflow box that clips it; cut out once nothing is left. What
    // clips follows the containing block chain: an absolute box escapes the boxes below its containing block (the
    // nearest positioned ancestor), a fixed box every box above it. A transform, filter or contain that makes
    // another containing block is not seen, and the image is then kept: a kept image costs at most the cap, a
    // dropped one a shot that misses it.
    const cut = (img: HTMLImageElement, r: DOMRect) => {
      const kept = { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      let position = getComputedStyle(img).position; // of the box whose clipping ancestors come next
      for (let el = img.parentElement; el && el !== stop && position !== "fixed"; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (position === "absolute" && style.position === "static") continue;
        const box = el.getBoundingClientRect();
        if (style.overflowX !== "visible") [kept.left, kept.right] = [Math.max(kept.left, box.left), Math.min(kept.right, box.right)];
        if (style.overflowY !== "visible") [kept.top, kept.bottom] = [Math.max(kept.top, box.top), Math.min(kept.bottom, box.bottom)];
        if (kept.left > kept.right || kept.top > kept.bottom) return true;
        position = style.position;
      }
      return false;
    };
    // Above the viewport too: a lazy image there that loads mid-shot would push the content down, in an engine
    // without scroll anchoring. Edges included: an image still loading has no size yet.
    const selected = () =>
      Array.from(document.images).filter((img) => {
        if (all) return true;
        const r = img.getBoundingClientRect();
        return img.checkVisibility(visible) && r.right >= left && r.left <= right && r.top <= bottom && !cut(img, r);
      });
    // One load and one error listener per image seen pending, each waking the pass in progress, all removed at
    // the end: a listener per image per pass would pile up on a page whose images settle one by one. Kept until
    // then, so an image that loads and is pending again (its src swapped) still wakes the wait.
    const off = new AbortController();
    const subscribed = new WeakSet<HTMLImageElement>();
    let wake = () => {};
    const ping = () => wake();
    let pending: HTMLImageElement[] = [];
    for (;;) {
      // Before the scan, so an image that settles after it ends this pass.
      const woken = new Promise<void>((done) => (wake = done));
      const images = selected();
      for (const img of images) if (img.loading === "lazy") img.loading = "eager";
      pending = images.filter((img) => !img.complete);
      if (pending.length === 0 || remaining() === 0) break;
      for (const img of pending) {
        if (subscribed.has(img)) continue;
        subscribed.add(img);
        img.addEventListener("load", ping, { signal: off.signal });
        img.addEventListener("error", ping, { signal: off.signal });
      }
      await Promise.race([woken, capped]);
    }
    off.abort();
    await Promise.race([Promise.all(selected().map((img) => img.decode().catch(() => undefined))), capped]);
    window.clearTimeout(timer);
    const src = (img: HTMLImageElement | undefined) => (img ? img.currentSrc || img.src : "");
    // Rendered ones only: a display: none tracking pixel that answers 204 is no broken image.
    const failed = selected().filter(
      (img) => img.complete && img.naturalWidth === 0 && src(img) !== "" && img.checkVisibility(shown),
    );
    // The note names the image, not its credentials, its signed query or its bytes.
    // ponytail: the one query parameter kept is the first named url, src or image that holds an http(s) URL (the image
    // an optimizer such as Next.js's /_next/image?url=… wraps), else every note on such a site reads the same. A
    // heuristic on the names; a loader with another one (?file=) is still dropped.
    const wrapped = (base: URL, raw: string | null) => {
      let value = (raw ?? "").trim();
      // searchParams decoded it once; twice more, so credentials do not hide behind %2540 or a leading space.
      for (let i = 0; i < 2; i++) {
        try {
          const decoded = decodeURIComponent(value).trim();
          if (decoded === value) break;
          value = decoded;
        } catch {
          break;
        }
      }
      if (value === "") return "";
      try {
        // Resolved against the image's own URL, where the loader would look; an unparsable value is dropped.
        const inner = new URL(value, base);
        if (inner.protocol !== "http:" && inner.protocol !== "https:") return ""; // data: in any case, javascript:, blob:
        [inner.username, inner.password, inner.search, inner.hash] = ["", "", "", ""];
        return /^\/(?![/\\])/.test(value) ? inner.pathname : inner.href; // a path stays a path
      } catch {
        return "";
      }
    };
    const short = (url: string) => {
      if (url.startsWith("data:")) return "a data: URL";
      try {
        const parsed = new URL(url);
        const kept = ["url", "src", "image"]
          .map((key) => ({ key, value: wrapped(parsed, parsed.searchParams.get(key)) }))
          .find(({ value }) => value !== "");
        [parsed.username, parsed.password, parsed.search, parsed.hash] = ["", "", "", ""];
        return parsed.href.slice(0, 80) + (kept ? `?${kept.key}=${kept.value.slice(0, 60)}` : "");
      } catch {
        return url.slice(0, 80);
      }
    };
    return { pending: pending.length, first: short(src(pending[0])), failed: failed.length, firstFailed: short(src(failed[0])) };
  }, { all, clip, visible: VISIBLE, shown: SHOWN, maxMs: 5000 });
}

// A page that scrolls inside an element (html and body at 100% with overflow
// hidden, a scrolling main) is one screen to the document. Names the element
// with the most hidden content that is shown, large and in the viewport (an
// offscreen drawer is not the page), or "". Open shadow roots are searched
// too, an app shell's own, and their element named after its hosts. Not the
// document's scrolling element, nor html, whose overflow is the viewport's, nor
// body while html's is visible and body has no containment, as then body's is:
// each is the document scrolling.
const scrollContainer = (page: Page, viewport: { width: number; height: number }): Promise<string> =>
  page.evaluate(({ v, shown }) => {
    const name = (el: Element) => el.localName + (el.id ? `#${el.id}` : "") + (el.classList[0] ? `.${el.classList[0]}` : "");
    const html = getComputedStyle(document.documentElement);
    const body = document.body ? getComputedStyle(document.body) : undefined;
    const own =
      html.overflowX === "visible" && html.overflowY === "visible" && body?.contain === "none" && body.contentVisibility === "visible"
        ? document.body
        : document.documentElement;
    const roots: Array<[Document | ShadowRoot, string]> = [[document, ""]];
    let best = "";
    let most = 100;
    for (const [root, hosts] of roots) {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) roots.push([el.shadowRoot, `${hosts}${name(el)} `]);
        const hidden = el.scrollHeight - el.clientHeight;
        if (hidden <= most || el === document.documentElement || el === document.scrollingElement || el === own) continue;
        const { overflowY } = getComputedStyle(el);
        if (overflowY !== "auto" && overflowY !== "scroll") continue;
        const r = el.getBoundingClientRect();
        if (r.height < v.height / 2 || r.width < v.width / 3) continue;
        if (r.right <= 0 || r.left >= v.width || r.bottom <= 0 || r.top >= v.height || !el.checkVisibility(shown)) continue;
        best = hosts + name(el);
        most = hidden;
      }
    }
    return best;
  }, { v: viewport, shown: SHOWN });

// One line in the terminal: no control, format or line-separator characters, no blanks, each once.
const clean = (notes: readonly unknown[]): string[] => [
  ...new Set(
    notes.map((note) => String(note).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim().slice(0, 200)).filter(Boolean),
  ),
];

const DOM_NOTE = "DOM still changing after 3 s";

async function quiet(page: Page, notes: string[]): Promise<void> {
  const settled = await settle(page);
  if (settled === true || notes.some((note) => note.startsWith(DOM_NOTE))) return;
  notes.push(settled ? `${DOM_NOTE} (most changed: ${settled})` : DOM_NOTE);
}

// Quiet first, so the scan sees the DOM the page's own scripts have finished
// building; quiet again after, because image loads run handlers of their own.
// Every cap that released a wait leaves a note, so a shot taken mid-motion or
// with images still loading says so.
// ponytail: motion that never touches the DOM (Web Animations API) is not seen.
// Await document.getAnimations() with finite timing in the last quiet wait if a
// site needs it; an infinite animation would otherwise pay the cap every shot.
async function ready(page: Page, notes: string[], all: boolean, clip?: SnapOptions["clip"]): Promise<void> {
  await quiet(page, notes);
  if (!(await loadFonts(page))) notes.push("font readiness still pending after 5 s");
  const images = await loadImages(page, all, clip);
  const count = (n: number) => `${n} image${n === 1 ? "" : "s"}`;
  // A lazy srcset image that never started has no URL to name.
  const first = (url: string) => (url ? ` (first: ${url})` : "");
  if (images.pending > 0) notes.push(`${count(images.pending)} still loading after 5 s${first(images.first)}`);
  if (images.failed > 0) notes.push(`${count(images.failed)} failed to load${first(images.firstFailed)}`);
  await quiet(page, notes);
}

/**
 * Numbered screenshots (`01.png`, `02.png`, …; as wide as `numbering`, in
 * `format`) in `root/dir`, listed in `shots` once every
 * plugin's `afterSnap` hook passed. The directory is wiped on
 * creation so a run never mixes with the previous run's files; it must lie
 * inside `root`.
 */
export function createSequence(
  page: Page,
  root: string,
  dir: string,
  {
    wrap = (_title, shoot) => shoot(),
    numbering = "00",
    format = {},
    plugins = [],
    ctx,
    signal,
    deviceScaleFactor,
  }: {
    // Runs one shot; the fixture wraps it in a `test.step` titled `01.png  <url>`,
    // so the terminal view can count shots and say where the sequence is.
    wrap?: (title: string, shoot: () => Promise<void>) => Promise<void>;
    numbering?: string;
    format?: ShotFormat;
    plugins?: readonly Plugin[];
    // What the hooks get; the fixture always passes it.
    ctx?: SequenceContext;
    // Aborted when the sequence ends: a shot still in flight then is not listed.
    signal?: AbortSignal;
    // The context's deviceScaleFactor option; the fixture passes it.
    deviceScaleFactor?: number;
  } = {},
): Sequence {
  const full = join(root, dir);
  // Wiped recursively, so it has to be the run's own: a run name or device
  // with ".." in it would otherwise take something else with it.
  const inside = relative(root, full);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`snapseq: refusing to wipe ${full}: not inside ${root}`);
  }
  // Whole, a hook's own directory inside included: the fixture has refused a directory another sequence writes into.
  rmSync(full, { recursive: true, force: true });
  mkdirSync(full, { recursive: true });

  const ext = format.type === "jpeg" ? "jpg" : "png";
  const shots: Shot[] = [];
  let counter = 0;
  // Device pixels per CSS pixel, fixed for the context: its option, which a page script cannot redefine like
  // devicePixelRatio. Read from the page only when the option is unset (a headed run takes the screen's), once,
  // at the first shot, and bounded: it sizes the label strip and the PDF page.
  let ratio = deviceScaleFactor;
  const open = async (options: SnapOptions | undefined): Promise<Shot> => {
    if (ratio === undefined) {
      const read: unknown = await page.evaluate(() => window.devicePixelRatio);
      ratio = typeof read === "number" && Number.isFinite(read) ? Math.min(16, Math.max(0.1, read)) : 1;
    }
    const index = counter + 1;
    const name = `${String(index).padStart(numbering.length, "0")}.${ext}`;
    return { name, path: join(full, name), url: page.url(), index, options: { ...options }, notes: [], format: { ...format }, deviceScaleFactor: ratio };
  };
  const hooks = async (kind: "beforeSnap" | "afterSnap", shot: Shot): Promise<void> => {
    for (const plugin of plugins) {
      try {
        await plugin[kind]?.(shot, ctx as SequenceContext);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`snapseq: plugin "${plugin.name}" threw in ${kind} on ${shot.name}: ${message}`, { cause });
      }
    }
  };
  const take = async (shot: Shot, readiness: string[]): Promise<string> => {
    // Claimed this late so a shot refused before its screenshot (snapPage's height check) gives its number back.
    counter = shot.index;
    // Locals: an afterSnap hook that edits the shot must not reach the step or the list.
    const { name, path } = shot;
    shot.url = page.url(); // a beforeSnap hook may have navigated
    const url = shot.url;
    // What the beforeSnap hooks pushed, then the readiness notes.
    const notes = clean([...shot.notes, ...readiness]);
    shot.notes = [...notes];
    await wrap(`${name}  ${url}`, async () => {
      // A beforeSnap hook may have set scale: "css", which makes the file 1x.
      shot.deviceScaleFactor = shot.options.scale === "css" ? 1 : ratio!; // set in open()
      // The config's type and quality (unset is PNG) and the numbered path win over anything a hook put in the options.
      try {
        await page.screenshot({ ...shot.options, type: format.type, quality: format.quality, path });
      } catch (cause) {
        // The notes were never printed for a shot that failed: a timeout on a page held by a stalled image has to say so.
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${message}; readiness: ${notes.length > 0 ? notes.join(", ") : "ok"}`, { cause });
      }
      // Inside the step, so the shot counts only once its hooks passed.
      await hooks("afterSnap", shot);
      if (signal?.aborted) throw new Error(`snapseq: the sequence ended before ${name} was listed`);
      shots.push(shot);
      // Worker stderr reaches every reporter; the list reporter prints it under the step.
      if (notes.length > 0) console.warn(`snapseq: ${name} taken with ${notes.join(", ")}  ${url}`);
    });
    return path;
  };

  // One shot at a time: a second snap before the first resolved (a hook taking
  // its own, a Promise.all in a sequence) would number and list them out of order.
  let busy = false;
  const one = async <T>(shoot: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error("snapseq: a shot is already in progress; await each snap before the next");
    busy = true;
    try {
      // A click that navigates resolves once the new document commits, while it
      // may still be parsing: the hooks, the URL and snapPage's first height
      // would see half a page. Not "load": a hung beacon would hold every shot
      // to the navigation bound, which bounds this wait too.
      await page.waitForLoadState("domcontentloaded");
      return await shoot();
    } finally {
      busy = false;
    }
  };

  return {
    snap: (options) => one(async () => {
      const shot = await open(options);
      await hooks("beforeSnap", shot);
      const notes: string[] = [];
      await ready(page, notes, !!shot.options.fullPage, shot.options.clip);
      return take(shot, notes);
    }),
    snapPage: (options) => one(async () => {
      // Before the viewport is read and grown, so what a hook changed is settled and measured.
      const shot = await open(options);
      await hooks("beforeSnap", shot);
      delete shot.options.fullPage; // the grown viewport is the full page already
      const viewport = page.viewportSize();
      if (!viewport) throw new Error("snapPage: the page has no viewport size");
      // The grown viewport scrolls the page to the top: read where the hooks left it, and in which document
      // (timeOrigin is its own per document), so a reload or a navigation since is not scrolled.
      const scroll = await page.evaluate(() => ({
        origin: window.performance.timeOrigin,
        left: window.scrollX,
        top: window.scrollY,
      }));
      const restore = async () => {
        await page.setViewportSize(viewport);
        // A navigation in flight after a listed shot must not fail the sequence over its scroll position.
        await page
          .evaluate(({ origin, left, top }) => {
            if (window.performance.timeOrigin !== origin) return;
            window.scrollTo({ left, top, behavior: "instant" });
            document.dispatchEvent(new Event("scroll", { bubbles: true })); // as after grow, for the restored viewport
          }, scroll)
          .catch(() => undefined);
      };
      // A grown viewport from the top scrolls nothing, so no scroll event fires: one is sent, as the browser sends it
      // (at the document, bubbling to the window), so UI that follows the scroll (a tray that hides at the page end) settles.
      const grow = async (height: number) => {
        await page.setViewportSize({ width: viewport.width, height });
        await page.evaluate(() => document.dispatchEvent(new Event("scroll", { bubbles: true })));
      };
      let height = await documentHeight(page);
      // One screen (64 px of slack for margins and a bar) whose content scrolls inside an element: a taller
      // viewport shows nothing more, and an app shell at 100% height with a body margin would grow with it and be
      // refused. Shot at the device's viewport, with a note. The element is never expanded.
      let inner = height <= viewport.height + 64 ? await scrollContainer(page, viewport) : "";
      let path: string;
      try {
        const notes: string[] = [];
        if (inner) {
          await ready(page, notes, false);
          // Content that landed during the wait can make it a page after all.
          height = await documentHeight(page);
          if (height > viewport.height + 64) inner = "";
        }
        if (!inner) {
          await grow(height);
          // Ready before measuring: an image that just loaded, a font that just
          // arrived, has its height now.
          await ready(page, notes, true);
          // Landing in flow can change the height; measure once more.
          const grown = await documentHeight(page);
          if (grown !== height) {
            height = grown;
            await grow(height);
            // Ready again, as what the taller viewport brings into view can start an image of its own (a section
            // whose observer sets its src).
            await ready(page, notes, true);
          }
          // Not a loop: a layout that follows the viewport grows with every
          // resize, and a shot of it would be cut off. Say so instead, with
          // what the hooks noted, as the refused shot is never listed.
          const after = await documentHeight(page);
          // An app shell whose content landed late grows with the viewport too: shot as it is, with the note.
          if (after > height) inner = await scrollContainer(page, viewport);
          if (after > height && !inner) {
            const said = clean([...shot.notes, ...notes]);
            throw new Error(
              `snapPage: the document grew from ${height} to ${after} px after the viewport was set to its height, so its layout follows the viewport (vh units, a loader at the page end, or isMobile on a page without a viewport meta). Use snap({ fullPage: true }) for this page.${said.length > 0 ? ` Notes: ${said.join(", ")}` : ""}`,
            );
          }
        }
        if (inner) notes.push(`the page scrolls inside <${inner}> not the document: scrollable content may be omitted`);
        path = await take(shot, notes);
      } catch (error) {
        // The shot's own error wins over a restore that fails after it.
        await restore().catch(() => undefined);
        throw error;
      }
      await restore();
      return path;
    }),
    dir: full,
    shots,
  };
}
