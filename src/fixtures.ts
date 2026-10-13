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
import type { SnapseqMetadata } from "./define.js";
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

  seq: async ({ page }, use, testInfo) => {
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
    const seq = createSequence(
      page,
      root,
      join(meta.run, captureId(testInfo), testInfo.project.name),
      (title, shoot) =>
        test.step(title, async () => {
          await shoot();
          if (idle > 0) testInfo.setTimeout(Math.ceil(performance.now() - started + idle));
        }),
      meta.numbering,
    );
    await use(seq);
    // The page as it was when the capture died, beside the shots it did take.
    // A step, like a shot, so the terminal view learns where it died: the page
    // the teardown found, which is not always the last shot's.
    if (testInfo.status === "failed" || testInfo.status === "timedOut") {
      const url = page.url();
      await test
        .step(`failed.png  ${url}`, async () => {
          await page.screenshot({ path: join(seq.dir, "failed.png"), timeout: 5_000 });
          appendFileSync(join(seq.dir, "shots.txt"), `failed.png  ${url}\n`);
        })
        .catch(() => {});
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
            const response = await route.fetch();
            const body = await response.text();
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
