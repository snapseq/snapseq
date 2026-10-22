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
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SnapseqMetadata } from "./define.js";
import type { Capture, CaptureShot } from "./orchestration/types.js";
import { createSequence, type Sequence, type Shot, type ShotFormat } from "./sequence.js";
import { configDirOf, DEFAULT_TITLE, sequenceId, sequenceIds } from "./sequence-id.js";
import { stabilize } from "./stabilize.js";

/** The bag handed to helpers that need more than `page`. Also available as the `ctx` fixture. */
export interface SequenceContext {
  page: Page;
  seq: Sequence;
  /** Active env name, e.g. `"dev"`. */
  env: string;
  /** Resolved base URL for this run. */
  host: string;
  /** Project name, e.g. `"desktop"`. */
  device: string;
}

interface SequenceFixtures {
  seq: Sequence;
  env: string;
  host: string;
  device: string;
  ctx: SequenceContext;
  /** Auto fixture: the env's `replay` routes, set up before the sequence runs. */
  replay: void;
}

interface WorkerFixtures {
  realisticUA: string;
}

type SequenceArgs = PlaywrightTestArgs &
  PlaywrightTestOptions &
  PlaywrightWorkerArgs &
  PlaywrightWorkerOptions &
  SequenceFixtures &
  WorkerFixtures;

type SequenceFn = (args: SequenceArgs, testInfo: TestInfo) => Promise<void> | void;

// Replay file -> the request (method, URL, body) --record claimed it for, in this worker's run.
// `label` is what the error shows; `id` adds the body, which can be large.
// ponytail: per worker process, and Playwright runs each project in its own, so per device; a lock file would make
// it per run.
const recorded = new Map<string, { id: string; label: string }>();

function metadataOf(testInfo: TestInfo): SnapseqMetadata {
  const meta = (testInfo.config.metadata as { snapseq?: SnapseqMetadata }).snapseq;
  if (!meta) throw new Error("snapseq: the Playwright config must come from snapseq's defineConfig()");
  return meta;
}

/**
 * Attaches the capture a passed sequence hands the orchestration parent as `snapseq-capture`, each shot field by field:
 * at most 1 MiB of JSON, paths and options, never the images. `format` is the config's, which every shot was taken in.
 */
export async function attachCapture(
  testInfo: TestInfo,
  part: Omit<Capture, "reused" | "shots">,
  shots: readonly Shot[],
  format: ShotFormat,
): Promise<void> {
  // What the files are: the config's `{}` is a PNG.
  const as = { ...format, type: format.type ?? "png" };
  const body = JSON.stringify({
    ...part,
    shots: shots.map(
      (shot): CaptureShot => ({
        index: shot.index,
        name: shot.name,
        path: shot.path,
        url: shot.url,
        notes: [...shot.notes],
        deviceScaleFactor: shot.deviceScaleFactor,
        format: as,
        options: shot.given,
      }),
    ),
  });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("snapseq: capture metadata over 1 MiB");
  await testInfo.attach("snapseq-capture", { contentType: "application/json", body });
}

export const test = base.extend<SequenceFixtures, WorkerFixtures>({
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

  // Not auto: a sequence skipped by a file-level skipIf must get no directory,
  // and a sequence that never touches `seq` gets no directory and no stabilize.
  seq: async ({ page, deviceScaleFactor, baseURL }, use, testInfo) => {
    if (testInfo.repeatEachIndex > 0 || testInfo.retry > 0) {
      throw new Error(
        "snapseq: --repeat-each and retries are not supported; a second run would overwrite the first run's screenshots",
      );
    }
    const meta = metadataOf(testInfo);
    const id = sequenceId(testInfo.project.testDir, testInfo.file, testInfo.titlePath.slice(1)); // [0] is the file
    // Before the wipe: in an orchestration run the capture reports this id and this host, and the parent caches it under the
    // id: neither may drift from what it asked for.
    const declared = meta.orchestration?.sequence;
    // NFC: macOS may hand Playwright the file's name decomposed, where the parent has the id as typed.
    if (declared !== undefined && id.normalize("NFC") !== declared.normalize("NFC")) {
      throw new Error(`snapseq: this file runs as "${declared}"; a describe title or a second test changes the id to "${id}"`);
    }
    if (declared !== undefined && baseURL !== meta.host) {
      throw new Error(`snapseq: the context's baseURL "${baseURL}" is not this run's host "${meta.host}"; a use.baseURL or test.use({ baseURL }) changed it`);
    }
    // `home.seq.ts` on mobile wipes `home/mobile/`, where `home/mobile.seq.ts` on any device and every sequence under
    // `home/mobile/` write too. A sequence file since deleted is not looked for; its output goes with the wipe.
    const device = testInfo.project.name;
    const inside = sequenceIds(join(testInfo.project.testDir, id)).find((s) => s === device || s.startsWith(`${device}/`));
    if (inside) {
      throw new Error(`snapseq: refusing to wipe ${join(meta.run, id, device)}: ${id}/${inside} writes inside it; rename one of the sequences`);
    }
    const root = resolve(configDirOf(testInfo.config), meta.screenshotsDir);
    mkdirSync(root, { recursive: true });
    const ignore = join(root, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

    // Each shot is a step named after its file, so the terminal view can count
    // shots as they land, and moves the deadline: the timeout is the time
    // allowed between shots, not per sequence, so a long sequence that keeps
    // landing shots never needs a bigger one and a hung one still dies.
    // ponytail: the renewal is short by the page setup Playwright charged before
    // this line (sub-second); an auto fixture taken first would make it exact.
    const started = performance.now(); // monotonic, like Playwright's own clock
    const idle = testInfo.timeout;
    const stabilizer = meta.stabilize === false ? undefined : stabilize(meta.stabilize, page);
    const seq = createSequence(page, root, join(meta.run, id, device), {
      wrap: (title, shoot) =>
        test.step(title, async () => {
          await shoot();
          if (idle > 0) testInfo.setTimeout(Math.ceil(performance.now() - started + idle));
        }),
      numbering: meta.numbering,
      format: meta.format,
      stabilizer,
      deviceScaleFactor,
    });
    // Before the body: what stabilize sets up on the page is there for its first line.
    await stabilizer?.begin();
    await use(seq);
    if (testInfo.status === "passed") {
      if (seq.inFlight) throw new Error("snapseq: a shot was still being taken when the sequence ended; await each snap");
      // What the orchestration parent reads back, under the id it asked for: the shots as data, never the files.
      if (declared !== undefined) {
        const part = { sequence: declared, device, env: meta.env, host: meta.host, dir: seq.dir };
        await attachCapture(testInfo, part, seq.shots, meta.format);
      }
    }
    // The page as it was when the sequence died, beside the shots it did take.
    // A step, like a shot, so the terminal view learns where it died: the page
    // the teardown found, which is not always the last shot's.
    if (testInfo.status === "failed" || testInfo.status === "timedOut") {
      const url = page.url();
      await test
        .step(`failed.png  ${url}`, async () => {
          // An image that never answers holds the load event, which the screenshot waits for: without this,
          // failed.png times out exactly when a stalled asset is why the sequence died. Abandoning pending images
          // changes the page, which a shot never does; here the sequence has failed and this is its last look.
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
        })
        .catch(() => {});
    }
  },

  ctx: async ({ page, seq, env, host, device }, use) => {
    await use({ page, seq, env, host, device });
  },

  // The env's `replay` requests, answered from their files before the sequence
  // runs; with --record, fetched live and written first. A missing file fails
  // here, before any shot, rather than silently replaying nothing.
  replay: [
    async ({ page }, use, testInfo) => {
      const meta = metadataOf(testInfo);
      const configDir = configDirOf(testInfo.config);
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
 * Declare the sequence in this file. One per file; the file name is the sequence's
 * name. Bound rather than wrapped so Playwright attributes the test to the
 * calling file, not to this one. The extended `test` is not exported: a second
 * sequence is a second file, so a shot's number stays its position in the file.
 */
export const sequence: (fn: SequenceFn) => void = (
  test as unknown as (title: string, fn: SequenceFn) => void
).bind(null, DEFAULT_TITLE);

/**
 * Skip a sequence: `skipIf(device !== "desktop", "desktop only")` inside the
 * body, or `skipIf(({ device }) => device !== "desktop", "desktop only")` at
 * the top of the file, which runs before any fixture. Playwright's `test.skip`.
 */
export const skipIf: typeof test.skip = test.skip;
