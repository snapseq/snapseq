import {
  test as base,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo,
} from "@playwright/test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SnapseqMetadata } from "./define.js";
import type { Plugin } from "./plugin.js";
import { createSequence, type Sequence } from "./sequence.js";

/** The bag handed to helpers that need more than `page`. Also available as the `ctx` fixture. */
export interface CaptureContext {
  page: Page;
  seq: Sequence;
  /** Active env name, e.g. `"dev"`. */
  env: string;
  /** Resolved base URL for this run. */
  host: string;
  /** Project name, e.g. `"desktop"`. */
  device: string;
}

export interface CaptureFixtures {
  seq: Sequence;
  env: string;
  host: string;
  device: string;
  ctx: CaptureContext;
  /** Auto fixture: the env's `replay` routes, set up before the capture runs. */
  replay: void;
  /** Option: the config's `plugins`, set by `defineConfig` as `use.snapseq`. */
  snapseq: { plugins: Plugin[] };
}

interface WorkerFixtures {
  realisticUA: string;
}

export type CaptureArgs = PlaywrightTestArgs &
  PlaywrightTestOptions &
  PlaywrightWorkerArgs &
  PlaywrightWorkerOptions &
  CaptureFixtures &
  WorkerFixtures;

export type CaptureFn = (args: CaptureArgs, testInfo: TestInfo) => Promise<void> | void;

const DEFAULT_TITLE = "capture";

// Replay file -> the request (method, URL, body) --record claimed it for, in this worker's run.
// `label` is what the error shows; `id` adds the body, which can be large.
// ponytail: per worker process, and Playwright runs each project in its own, so per device; a lock file would make
// it per run.
const recorded = new Map<string, { id: string; label: string }>();

function configDirOf(testInfo: TestInfo): string {
  return testInfo.config.configFile
    ? dirname(testInfo.config.configFile)
    : testInfo.config.rootDir;
}

function metadataOf(testInfo: TestInfo): SnapseqMetadata {
  const meta = (testInfo.config.metadata as { snapseq?: SnapseqMetadata }).snapseq;
  if (!meta) throw new Error("snapseq: the Playwright config must come from snapseq's defineConfig()");
  return meta;
}

/**
 * `captures/nested/pricing.capture.ts` → `nested/pricing`. A titled test or a
 * `describe` block appends its titles, so two "hero" tests in different
 * describes never share (and wipe) one directory.
 */
export function captureId(testInfo: TestInfo): string {
  // realpath both sides: Playwright reports the file through resolved symlinks
  // (macOS /var → /private/var) while testDir keeps the configured path, and a
  // mismatch would make relative() escape the screenshots root.
  const rel = relative(
    realpathSync(testInfo.project.testDir),
    realpathSync(testInfo.file),
  ).replace(/\.capture\.[cm]?[jt]s$/, "");
  const titles = testInfo.titlePath.slice(1); // [0] is the file
  return titles.length === 1 && titles[0] === DEFAULT_TITLE ? rel : join(rel, ...titles);
}

export const test = base.extend<CaptureFixtures, WorkerFixtures>({
  // Headless Chromium announces itself as "HeadlessChrome", which some WAFs 403.
  // The UA is fixed per browser process, so read it once per worker.
  realisticUA: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const ua = await (await context.newPage()).evaluate(() => navigator.userAgent);
      await context.close();
      await use(ua.replace("HeadlessChrome", "Chrome"));
    },
    { scope: "worker" },
  ],
  // An explicit userAgent (project `use`, test.use) still wins.
  contextOptions: async ({ contextOptions, realisticUA }, use) => {
    await use({ ...contextOptions, userAgent: contextOptions.userAgent ?? realisticUA });
  },

  env: async ({}, use, testInfo) => {
    await use(metadataOf(testInfo).env);
  },
  host: async ({}, use, testInfo) => {
    await use(metadataOf(testInfo).host);
  },
  device: async ({}, use, testInfo) => {
    await use(testInfo.project.name);
  },

  snapseq: [{ plugins: [] }, { option: true }],

  // Not auto: a capture skipped by a file-level skipIf must get no directory,
  // and a capture that never touches `seq` has no sequence and no plugin hooks.
  seq: async ({ page, snapseq, deviceScaleFactor }, use, testInfo) => {
    if (testInfo.repeatEachIndex > 0 || testInfo.retry > 0) {
      throw new Error(
        "snapseq: --repeat-each and retries are not supported; a second run would overwrite the first run's screenshots",
      );
    }
    const meta = metadataOf(testInfo);
    const root = resolve(configDirOf(testInfo), meta.screenshotsDir);
    mkdirSync(root, { recursive: true });
    const ignore = join(root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

    // Each shot is a step named after its file, so the terminal view can count
    // shots as they land, and moves the deadline: the timeout is the time
    // allowed between shots, not per capture, so a long capture that keeps
    // landing shots never needs a bigger one and a hung one still dies.
    // ponytail: the renewal is short by the page setup Playwright charged before
    // this line (sub-second); an auto fixture taken first would make it exact.
    const started = performance.now(); // monotonic, like Playwright's own clock
    const idle = testInfo.timeout;
    const ended = new AbortController();
    // The hooks' context, built here: the ctx fixture depends on seq. seq is bound below.
    const ctx = { page, env: meta.env, host: meta.host, device: testInfo.project.name } as CaptureContext;
    const seq = createSequence(page, root, join(meta.run, captureId(testInfo), testInfo.project.name), {
      wrap: (title, shoot) =>
        test.step(title, async () => {
          await shoot();
          if (idle > 0 && !ended.signal.aborted) {
            testInfo.setTimeout(Math.ceil(performance.now() - started + idle));
          }
        }),
      numbering: meta.numbering,
      format: meta.format,
      plugins: snapseq.plugins,
      ctx,
      signal: ended.signal,
      deviceScaleFactor,
    });
    ctx.seq = seq;
    // Before the body: what a plugin sets up on the page is there for its first line.
    for (const plugin of snapseq.plugins) {
      try {
        await plugin.begin?.(ctx);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`snapseq: plugin "${plugin.name}" threw in begin: ${message}`, { cause });
      }
    }
    await use(seq);
    ended.abort();
    // A done or failed hook gets the capture timeout. Playwright's own budget for
    // this teardown grows with every renewal above, and a hung PDF would get it all.
    const bounded = <T>(work: Promise<T>): Promise<T> => {
      if (idle <= 0) return work;
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`took longer than ${idle} ms`)), idle);
      });
      return Promise.race([work, limit]).finally(() => clearTimeout(timer));
    };
    // Each plugin's done or failed hook in a step named after the plugin.
    const after = async (kind: "done" | "failed") => {
      for (const plugin of snapseq.plugins) {
        const run = plugin[kind];
        if (!run) continue;
        await test.step(plugin.name, async () => {
          try {
            await bounded(run.call(plugin, seq.shots, ctx));
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`snapseq: plugin "${plugin.name}" threw in ${kind}: ${message}`, { cause });
          }
        });
      }
    };
    if (testInfo.status === "passed") await after("done");
    // The page as it was when the capture died, beside the shots it did take.
    // A step, like a shot, so the terminal view learns where it died: the page
    // the teardown found, which is not always the last shot's.
    if (testInfo.status === "failed" || testInfo.status === "timedOut") {
      const url = page.url();
      await test
        .step(`failed.png  ${url}`, async () => {
          // An image that never answers holds the load event, which the screenshot waits for: without this,
          // failed.png times out exactly when a stalled asset is why the capture died. Abandoning pending images
          // changes the page, which a shot never does; here the capture has failed and this is its last look.
          // A <picture> keeps its selected <source> when the <img> loses its own attributes, and a frame's image
          // holds the parent's load event too, so every frame is visited, under one 2 s deadline: a page too stuck
          // to evaluate still gets its 5 s try at the screenshot.
          const abandon = page.frames().map((frame) =>
            frame
              .evaluate(() => {
                for (const img of Array.from(document.images)) {
                  if (img.complete) continue;
                  for (const attr of ["src", "srcset"]) img.removeAttribute(attr);
                  if (img.parentElement?.localName === "picture") {
                    for (const source of Array.from(img.parentElement.querySelectorAll("source"))) source.removeAttribute("srcset");
                  }
                }
              })
              .catch(() => {}),
          );
          await Promise.race([Promise.all(abandon), sleep(2_000, undefined, { ref: false })]);
          await page.screenshot({ path: join(seq.dir, "failed.png"), timeout: 5_000 });
          appendFileSync(join(seq.dir, "shots.txt"), `failed.png  ${url}\n`);
        })
        .catch(() => {});
      // Not swallowed like failed.png: a failed hook that throws says so.
      await after("failed");
    }
  },

  ctx: async ({ page, seq, env, host, device }, use) => {
    await use({ page, seq, env, host, device });
  },

  // The env's `replay` requests, answered from their files before the capture
  // runs; with --record, fetched live and written first. A missing file fails
  // here, before any shot, rather than silently replaying nothing.
  replay: [
    async ({ page }, use, testInfo) => {
      const meta = metadataOf(testInfo);
      const configDir = configDirOf(testInfo);
      for (const [pattern, rel] of Object.entries(meta.replay ?? {})) {
        const file = resolve(configDir, rel);
        if (meta.record) {
          await page.route(pattern, async (route) => {
            // A glob matches any host: a third-party request that matches too must not overwrite the file.
            // One file holds one response, so another method or body is a second request too.
            const request = route.request();
            const url = request.url();
            const label = `${request.method()} ${url}`;
            // A FormData body carries a random boundary, new on every send. Its delimiter lines compared as one
            // constant, the same form is one request; a field value that happens to hold the boundary is left alone.
            let posted = request.postData() ?? "";
            const type = request.headers()["content-type"] ?? "";
            const param = /^multipart\/form-data\s*(;|$)/i.test(type) ? /;\s*boundary=(?:"([^"]*)"|([^;\s]+))/i.exec(type) : null;
            const boundary = param?.[1] ?? param?.[2];
            if (boundary) {
              const delimiters = [`--${boundary}`, `--${boundary}--`];
              posted = posted
                .split(/\r?\n/)
                .map((line) => (delimiters.includes(line) ? "--boundary--" : line))
                .join("\n");
            }
            const id = `${label} ${posted}`;
            const first = recorded.get(file);
            if (first !== undefined && first.id !== id) {
              const differ = first.label === label ? " (the bodies differ)" : "";
              throw new Error(`snapseq: --record: ${pattern} matched a second request ${label}; ${rel} already written from ${first.label}${differ}`);
            }
            recorded.set(file, { id, label }); // claimed before the fetch, so two at once cannot both pass
            const response = await route.fetch();
            // Refuse before writing: the file replays as a 200 JSON body, so a saved 403
            // or an HTML error page would stand in for the real response on every later run.
            const status = response.status();
            if (status < 200 || status > 299) {
              throw new Error(`snapseq: --record got ${status} for ${url}; ${rel} not written`);
            }
            const body = await response.text();
            try {
              JSON.parse(body);
            } catch {
              throw new Error(`snapseq: --record got a non-JSON body for ${url}; ${rel} not written`);
            }
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, body);
            await route.fulfill({ response, body });
          });
        } else {
          if (!existsSync(file)) {
            throw new Error(
              `snapseq: no replay file for ${pattern}: ${rel}. Record it with --record against a host where the request succeeds.`,
            );
          }
          // ponytail: JSON only; a HAR via page.routeFromHAR covers anything else.
          const body = readFileSync(file, "utf8");
          // Parsed once, here: served as application/json, a hand-edited file would break the widget silently.
          try {
            JSON.parse(body);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`snapseq: replay file ${rel} is not JSON: ${message}`, { cause });
          }
          await page.route(pattern, (route) =>
            route.fulfill({ body, contentType: "application/json" }),
          );
        }
      }
      await use();
    },
    { auto: true },
  ],
});

/**
 * Declare the capture in this file. One per file; the file name is the capture's
 * name. Bound rather than wrapped so Playwright attributes the test to the
 * calling file, not to this one. The extended `test` is not exported: a second
 * capture is a second file, so a shot's number stays its position in the file.
 */
export const capture: (fn: CaptureFn) => void = (
  test as unknown as (title: string, fn: CaptureFn) => void
).bind(null, DEFAULT_TITLE);

/**
 * Skip a capture: `skipIf(device !== "desktop", "desktop only")` inside the
 * body, or `skipIf(({ device }) => device !== "desktop", "desktop only")` at
 * the top of the file, which runs before any fixture. Playwright's `test.skip`.
 */
export const skipIf: typeof test.skip = test.skip;
