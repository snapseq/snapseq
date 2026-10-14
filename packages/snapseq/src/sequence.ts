import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Page, PageScreenshotOptions } from "@playwright/test";
import type { CaptureContext } from "./fixtures.js";
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
   * Viewport screenshot once the page is ready: the DOM quiet, fonts in and
   * every image loaded. Resolves to the file path. `{ fullPage: true }` is
   * Playwright's native full page: the viewport stays as it is, so sticky and
   * fixed elements come out pinned where the current scroll left them.
   */
  snap(options?: SnapOptions): Promise<string>;
  /**
   * The whole page as a reviewer expects it: the viewport grows to the
   * document height, so sticky and fixed elements rest in flow and anything
   * that reacts to its slot coming into view (a tray that lands) gets to; the
   * page gets ready; one shot; the viewport is restored. A layout that
   * follows the viewport height (`vh` units, a loader at the page end) grows
   * with every resize and is refused: use `snap({ fullPage: true })` for those.
   */
  snapPage(options?: Omit<SnapOptions, "fullPage">): Promise<string>;
  /** Directory the screenshots are written to. */
  readonly dir: string;
  /** Every shot listed so far, in order: each one's plugin `afterSnap` hooks passed. */
  readonly shots: readonly Shot[];
}

const documentHeight = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollHeight);

// ponytail: quiet-DOM heuristic (no mutation for 200 ms, 3 s cap), then two
// frames so the result is painted. Every shot waits for it, so JS-driven motion
// that touches the DOM each frame (a carousel spring, a chart growing) ends
// before the shot. It sees nothing but DOM mutations in this document: a state
// that lands slower, or arrives over video, canvas or an iframe, needs an
// explicit wait before the shot. Resolves false when the cap released it.
async function settle(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ quietMs, maxMs }) =>
      new Promise<boolean>((resolve) => {
        const observer = new MutationObserver(() => {
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
          resolve(false);
        }, maxMs);
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }).then(
        (quiet) =>
          new Promise<boolean>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(quiet))),
          ),
      ),
    { quietMs: 200, maxMs: 3000 },
  );
}

// A face that arrives late changes every line's metrics, so a height measured
// before it is wrong. The screenshot itself waits for fonts, but by then
// snapPage has fixed the viewport. Resolves false when the cap released it.
async function loadFonts(page: Page): Promise<boolean> {
  return page.evaluate(
    (maxMs) =>
      Promise.race([
        document.fonts.ready.then(() => true),
        new Promise<boolean>((done) => window.setTimeout(() => done(false), maxMs)),
      ]),
    5000,
  );
}

// Every <img> in the document: lazy ones are made eager so they start at all
// (a native full page never scrolls them into view), then all of them get to
// load, or fail; rescanned whenever one settles, until nothing is pending,
// because a load handler can start another image (a placeholder swapping in
// the real one) and a stalled one must not hide it; then decoded. 5 s at most
// for the lot, and a stalled one is waited for again on the next shot. Resolves
// to how many were still pending at the cap. CSS backgrounds, iframes and
// shadow trees are not seen. No named inner functions: bundlers wrap those in
// a helper the page does not have.
async function loadImages(page: Page): Promise<number> {
  return page.evaluate(async (maxMs) => {
    const deadline = performance.now() + maxMs;
    const remaining = () => Math.max(0, deadline - performance.now());
    const timeout = () => new Promise<void>((done) => window.setTimeout(done, remaining()));
    let pending: HTMLImageElement[] = [];
    for (;;) {
      const images = Array.from(document.images);
      for (const img of images) if (img.loading === "lazy") img.loading = "eager";
      pending = images.filter((img) => !img.complete);
      if (pending.length === 0 || remaining() === 0) break;
      await Promise.race([
        ...pending.map(
          (img) =>
            new Promise<void>((done) => {
              img.addEventListener("load", () => done(), { once: true });
              img.addEventListener("error", () => done(), { once: true });
            }),
        ),
        timeout(),
      ]);
    }
    await Promise.race([
      Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined))),
      timeout(),
    ]);
    return pending.length;
  }, 5000);
}

const DOM_NOTE = "DOM still changing after 3 s";

async function quiet(page: Page, notes: string[]): Promise<void> {
  if (!(await settle(page)) && !notes.includes(DOM_NOTE)) notes.push(DOM_NOTE);
}

// Quiet first, so the scan sees the DOM the page's own scripts have finished
// building; quiet again after, because image loads run handlers of their own.
// Every cap that released a wait leaves a note, so a shot taken mid-motion or
// with images still loading says so.
// ponytail: motion that never touches the DOM (Web Animations API) is not seen.
// Await document.getAnimations() with finite timing in the last quiet wait if a
// site needs it; an infinite animation would otherwise pay the cap every shot.
async function ready(page: Page, notes: string[]): Promise<void> {
  await quiet(page, notes);
  if (!(await loadFonts(page))) notes.push("fonts still loading after 5 s");
  const pending = await loadImages(page);
  if (pending > 0) notes.push(`${pending} image${pending === 1 ? "" : "s"} still loading after 5 s`);
  await quiet(page, notes);
}

/**
 * Numbered screenshots (`01.png`, `02.png`, …; as wide as `numbering`, in
 * `format`) in `root/dir`, listed with their URLs in `shots.txt` once every
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
  }: {
    // Runs one shot; the fixture wraps it in a `test.step` titled `01.png  <url>`,
    // so the terminal view can count shots and say where the capture is.
    wrap?: (title: string, shoot: () => Promise<void>) => Promise<void>;
    numbering?: string;
    format?: ShotFormat;
    plugins?: readonly Plugin[];
    // What the hooks get; the fixture always passes it.
    ctx?: CaptureContext;
    // Aborted when the capture ends: a shot still in flight then is not listed.
    signal?: AbortSignal;
  } = {},
): Sequence {
  const full = join(root, dir);
  // Wiped recursively, so it has to be the run's own: a run name or device
  // with ".." in it would otherwise take something else with it.
  const inside = relative(root, full);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`snapseq: refusing to wipe ${full}: not inside ${root}`);
  }
  rmSync(full, { recursive: true, force: true });
  mkdirSync(full, { recursive: true });

  const ext = format.type === "jpeg" ? "jpg" : "png";
  const shots: Shot[] = [];
  let counter = 0;
  // Device pixels per CSS pixel: fixed for the context, so read once, at the first shot.
  let deviceScaleFactor: number | undefined;
  const open = async (options: SnapOptions | undefined): Promise<Shot> => {
    deviceScaleFactor ??= await page.evaluate(() => window.devicePixelRatio);
    const index = counter + 1;
    const name = `${String(index).padStart(numbering.length, "0")}.${ext}`;
    return { name, path: join(full, name), url: page.url(), index, options: { ...options }, notes: [], format: { ...format }, deviceScaleFactor };
  };
  const hooks = async (kind: "beforeSnap" | "afterSnap", shot: Shot): Promise<void> => {
    for (const plugin of plugins) {
      try {
        await plugin[kind]?.(shot, ctx as CaptureContext);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`snapseq: plugin "${plugin.name}" threw in ${kind} on ${shot.name}: ${message}`, { cause });
      }
    }
  };
  const take = async (shot: Shot, notes: string[]): Promise<string> => {
    // Claimed this late so a shot refused before its screenshot (snapPage's height check) gives its number back.
    counter = shot.index;
    // Locals: an afterSnap hook that edits the shot must not reach the step or the manifest.
    const { name, path } = shot;
    shot.url = page.url(); // a beforeSnap hook may have navigated
    const url = shot.url;
    shot.notes = [...notes];
    await wrap(`${name}  ${url}`, async () => {
      // The config's type and quality (unset is PNG) and the numbered path win over anything a hook put in the options.
      await page.screenshot({ ...shot.options, type: format.type, quality: format.quality, path });
      // Inside the step, so the shot counts only once its hooks passed.
      await hooks("afterSnap", shot);
      if (signal?.aborted) throw new Error(`snapseq: the capture ended before ${name} was listed`);
      shots.push(shot);
      const note = notes.length > 0 ? `  ${notes.join(", ")}` : "";
      appendFileSync(join(full, "shots.txt"), `${name}  ${url}${note}\n`);
      // Worker stderr reaches every reporter; the list reporter prints it under the step.
      if (note) console.warn(`snapseq: ${name} taken with${note}  ${url}`);
    });
    return path;
  };

  // One shot at a time: a second snap before the first resolved (a hook taking
  // its own, a Promise.all in a capture) would number and list them out of order.
  let busy = false;
  const one = async <T>(shoot: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error("snapseq: a shot is already in progress; await each snap before the next");
    busy = true;
    try {
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
      await ready(page, notes);
      return take(shot, notes);
    }),
    snapPage: (options) => one(async () => {
      // Before the viewport is read and grown, so what a hook changed is settled and measured.
      const shot = await open(options);
      await hooks("beforeSnap", shot);
      delete shot.options.fullPage; // the grown viewport is the full page already
      const viewport = page.viewportSize();
      if (!viewport) throw new Error("snapPage: the page has no viewport size");
      const grow = (height: number) => page.setViewportSize({ width: viewport.width, height });
      let height = await documentHeight(page);
      await grow(height);
      try {
        // Ready before measuring: an image that just loaded, a font that just
        // arrived, has its height now.
        const notes: string[] = [];
        await ready(page, notes);
        // Landing in flow can change the height; measure once more.
        const grown = await documentHeight(page);
        if (grown !== height) {
          height = grown;
          await grow(height);
          await quiet(page, notes);
        }
        // Not a loop: a layout that follows the viewport grows with every
        // resize, and a shot of it would be cut off. Say so instead.
        const after = await documentHeight(page);
        if (after > height) {
          throw new Error(
            `snapPage: the document grew from ${height} to ${after} px after the viewport was set to its height, so its layout follows the viewport (vh units, a loader at the page end). Use snap({ fullPage: true }) for this page.`,
          );
        }
        return await take(shot, notes);
      } finally {
        await page.setViewportSize(viewport);
      }
    }),
    dir: full,
    shots,
  };
}
