// run(): one sequence, now, in a child `playwright test`: validate, reuse what may be reused, spawn for the rest,
// accept per capture and per call. The Errors section of docs/orchestration.md lists what a call rejects with.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import { formatRow, marks, shotCount, type OutStream } from "../reporter.js";
import { canonical, matchSequence, rowLabel, sequenceIds } from "../sequence-id.js";
import { type CachedCapture, type Origin, cacheDir, isFile, loadCache, reusable, saveCache } from "./cache.js";
import type { Entry, Report } from "./result-reporter.js";
import type { Request } from "./request.js";
import { type Child, type Closed, spawnChild } from "./spawn.js";
import type { Capture, CaptureShot, ResolvedSnapseqConfig, RunOptions } from "./types.js";
import { type Checked, checkRun, isDirName } from "./validate.js";

export interface Target {
  env?: string;
  host?: string;
}

/**
 * What the command line asked to reshoot: globs over sequence ids (or the ids themselves), the sequence files named by
 * path (`files`: the word as typed → its canonical path, for the words that are one) and exact device names.
 */
export interface Filters {
  readonly sequences: readonly string[];
  readonly files?: ReadonlyMap<string, string>;
  readonly devices: readonly string[];
}

export const filtering = (f: Filters): boolean => f.sequences.length > 0 || f.devices.length > 0;

/** The words that select this sequence, `file` being the call's sequence file: a file word by its path, the rest by id. */
const selecting = (f: Filters, sequence: string, file: string): string[] =>
  f.sequences.filter((word) => {
    const named = f.files?.get(word);
    return named !== undefined ? named === canonical(file) : matchSequence(sequence, word);
  });

/** A part matches when one of the words selects its sequence and its device is one of the names; an empty list matches all. */
export const matches = (f: Filters, sequence: string, device: string, file = ""): boolean =>
  (f.sequences.length === 0 || selecting(f, sequence, file).length > 0) && (f.devices.length === 0 || f.devices.includes(device));

/** `"12346" --device mobile`, as typed, for `no part matched …`. */
export const describeFilters = (f: Filters): string =>
  [...f.sequences.map((s) => JSON.stringify(s)), ...f.devices.map((d) => `--device ${d}`)].join(" ");

/** The parent's own row for a part (`= … reused  12 shots`, `+ … building, no capture yet`), laid out as a child's rows. */
export const partLine = (out: OutStream, mark: string, label: string, width: number, text: string): unknown =>
  out.write(`${formatRow(marks(out), mark, label, width, text)}\n`);

/** What every run() of one orchestration shares. */
export interface Session {
  config: ResolvedSnapseqConfig;
  /** Absolute. */
  configFile: string;
  run: string;
  /** `--env`/`--host`, or the SNAPSEQ_ENV/SNAPSEQ_HOST snapseq started with: over every run's own. */
  invocation: Target;
  /** `--record`: becomes SNAPSEQ_RECORD in each child. */
  record?: string;
  filters: Filters;
  cacheFile: string;
  /** The child's argv: node, Playwright's CLI, `test -c <config>`, the pass-through flags. */
  command: readonly string[];
  out: OutStream;
}

interface Call {
  sequence: string;
  site?: string;
  child?: Child;
  promise?: Promise<readonly Capture[]>;
}

// snapseq's own frames: the bundle in dist/, or this folder in the sources.
const OWN = dirname(fileURLToPath(import.meta.url)) + sep;

/** `spring.orchestration.ts:9`: the first frame of `stack` outside snapseq's own files. */
export function callSite(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const text = line.trim();
    if (!text.startsWith("at ")) continue;
    // `at fn (location)`: the first " (" ends the name, as a path may hold a "(" of its own.
    const at = text.endsWith(")") ? text.slice(text.indexOf(" (") + 2, -1) : text.replace(/^at (?:async )?/, "");
    const m = /^(.*):(\d+):\d+$/.exec(at);
    if (!m) continue;
    const file = m[1]!.startsWith("file://") ? fileURLToPath(m[1]!) : m[1]!;
    if (isAbsolute(file) && !file.startsWith(OWN)) return `${basename(file)}:${m[2]}`;
  }
  return undefined;
}

/**
 * Layers from low to high, over the config's own (which the child resolves): the run's options, then the invocation.
 * An env at a layer resets the host to that env's own; a host at the same layer wins over it. Only explicit values
 * come out: the child resolves the rest, so the parent never makes up a host.
 */
export function target(options: Target, invocation: Target): Target {
  let env: string | undefined;
  let host: string | undefined;
  for (const layer of [options, invocation]) {
    if (layer.env !== undefined) {
      env = layer.env;
      host = undefined;
    }
    if (layer.host !== undefined) host = layer.host;
  }
  return { env, host };
}

/** The first line of a child's error text, without color or the `Error: ` Playwright starts it with. */
const firstLine = (s: unknown): string =>
  (String(s).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n")[0] ?? "").replace(/^Error: /, "");

function parseReport(closed: Closed): Report | undefined {
  if (closed.report === undefined) return undefined;
  try {
    const r = JSON.parse(closed.report) as Report;
    if (typeof r?.status === "string" && Array.isArray(r.errors) && Array.isArray(r.tests)) return r;
  } catch {}
  return undefined;
}

/** Why a passed entry's capture cannot be used as it is, or undefined when it can. */
function captureProblem(entry: Entry, sequence: string, dir: string): string | undefined {
  const c = entry.capture as CachedCapture | null;
  if (entry.error !== null) return entry.error;
  if (!c || typeof c !== "object") return "no capture";
  // NFC: macOS may hand the child the file's name decomposed.
  if (String(c.sequence).normalize("NFC") !== sequence.normalize("NFC") || c.device !== entry.device) return `a capture of ${c.sequence}/${c.device}`;
  if (typeof c.dir !== "string" || canonical(c.dir).normalize("NFC") !== canonical(dir).normalize("NFC")) return `shots in ${c.dir}, not ${dir}`;
  if (!Array.isArray(c.shots)) return "no shots";
  const seen = new Set<number>();
  for (const shot of c.shots as CaptureShot[]) {
    if (!Number.isInteger(shot?.index) || shot.index <= 0 || seen.has(shot.index)) return `shot index ${shot?.index}`;
    seen.add(shot.index);
    if (typeof shot.name !== "string" || !isDirName(shot.name) || shot.path !== join(c.dir, shot.name)) {
      return `shot ${shot.index} is not a file in ${c.dir}`;
    }
    if (!Number.isFinite(shot.deviceScaleFactor) || shot.deviceScaleFactor <= 0) {
      return `shot ${shot.name} has deviceScaleFactor ${shot.deviceScaleFactor}`;
    }
    if (!isFile(shot.path)) return `${shot.path} is not a file`;
  }
  return undefined;
}

/**
 * Which captures are good on their own (cached even when a sibling failed), and whether the call resolves; when it
 * does not, why, in the words of the Errors section of docs/orchestration.md.
 */
function judge(sequence: string, order: readonly string[], closed: Closed, dirOf: (device: string) => string) {
  const accepted = new Map<string, CachedCapture>();
  if (closed.error !== undefined) return { accepted, report: undefined, problem: `${sequence}: could not start the child: ${closed.error}` };
  const report = parseReport(closed);
  if (!report) return { accepted, report, problem: `${sequence}: child exited before reporting; see the output above` };
  const failed: string[] = [];
  const notRun: string[] = [];
  const unused: string[] = [];
  const other: string[] = [];
  let most = 0;
  for (const device of order) {
    const entries = report.tests.filter((t) => t.device === device);
    most = Math.max(most, entries.length);
    const e = entries[0];
    if (!e) notRun.push(device);
    else if (entries.length > 1) continue;
    // No capture and no error: the sequence never used seq (result-reporter.ts).
    else if (e.status === "passed" && e.capture === null && e.error === null) unused.push(device);
    else if (e.status === "passed") {
      const why = captureProblem(e, sequence, dirOf(device));
      if (why !== undefined) other.push(`reported no usable capture on ${device}: ${firstLine(why)}`);
      else if (report.status !== "interrupted") accepted.set(device, e.capture as CachedCapture);
    } else if (e.status === "skipped") other.push(`was skipped on ${device}${e.skipReason ? `: "${e.skipReason}"` : ""}`);
    else if (e.status === "not run") notRun.push(device);
    else failed.push(device);
  }
  const strangers = report.tests.map((t) => t.device).filter((d) => !order.includes(d));
  const blame = [
    failed.length > 0 ? `failed on ${failed.join(", ")}` : "",
    ...other,
    unused.length > 0 ? `never used seq on ${unused.join(", ")}` : "",
  ].filter(Boolean);
  const notRunPart = notRun.length > 0 ? `not run on ${notRun.join(", ")}${failed[0] ? ` after ${failed[0]} failed` : ""}` : "";
  let problem: string | undefined;
  if (most > 1) problem = `${sequence} ran ${most} tests; one sequence per file`;
  else if (strangers.length > 0) problem = `${sequence}: child reported devices it was not asked for: ${strangers.join(", ")}`;
  // An error outside any test (a server that never came up) says more than "not run" on every device.
  else if (report.errors.length > 0 && blame.length === 0) problem = `${sequence}: ${firstLine(report.errors[0])}`;
  else if (blame.length > 0 || notRunPart) problem = `${sequence} ${[blame[0], notRunPart, ...blame.slice(1)].filter(Boolean).join(", ")}`;
  else if (report.status !== "passed" || closed.code !== 0) {
    const end = report.status === "interrupted" ? "was interrupted" : `child ended with ${closed.code ?? closed.signal} after reporting ${report.status}`;
    problem = `${sequence}: ${end}; see the output above`;
  }
  return { accepted, report, problem };
}

/** The run() handed to the orchestration, and what main needs to finish: the call still going, counts, a stop. */
export function createRunner(s: Session) {
  const configDir = dirname(s.configFile);
  const cache = loadCache(s.cacheFile);
  /** The ids in the sequences folder, read once, so rows line up across children. */
  const ids = sequenceIds(resolve(configDir, s.config.sequencesDir));
  /** `<sequence>/<device>` this orchestration already got back from a run(), reused ones included. */
  const claims = new Set<string>();
  /** The fingerprints of a failed call's accepted captures, for its retry; the captures are in the run's cache. */
  const held = new Map<string, string>();
  const state = {
    active: undefined as Call | undefined,
    stopped: false,
    /** A part matched the filters; a part built only because there was nothing to reuse does not count. */
    matched: false,
    /** The sequence words that selected such a part. */
    hit: new Set<string>(),
    shots: 0,
    tally: {} as Record<string, number>,
  };
  let requests = 0;

  function run(sequence: string, options: RunOptions = {}, ...playwright: PlaywrightTestConfig[]): Promise<readonly Capture[]> {
    const site = callSite(new Error().stack);
    const where = site ? ` (${site})` : "";
    if (state.stopped) return Promise.reject(new Error(`run("${sequence}") after the orchestration stopped${where}`));
    if (state.active) {
      return Promise.reject(new Error(`run("${sequence}") while "${state.active.sequence}" is running; await it first${where}`));
    }
    // Taken before the first await; only this call clears it, once its child and cleanup settled.
    const call: Call = { sequence, site };
    state.active = call;
    call.promise = execute(call, options, playwright).finally(() => {
      if (state.active === call) state.active = undefined;
    });
    return call.promise;
  }

  async function execute(call: Call, options: RunOptions, playwright: PlaywrightTestConfig[]): Promise<readonly Capture[]> {
    const { sequence } = call;
    const where = call.site ? ` (${call.site})` : "";
    let checked: Checked;
    try {
      checked = checkRun(sequence, options, playwright, { config: s.config, configDir, invocationEnv: s.invocation.env });
    } catch (err) {
      throw new Error(`${String(sequence)}: ${(err as Error).message}${where}`);
    }
    // Composed, as the file lookup and the fixture compare ids: two spellings of one id are one part.
    const keyOf = (device: string): string => `${sequence.normalize("NFC")}/${device}`;
    for (const device of checked.deviceOrder) {
      if (claims.has(keyOf(device))) throw new Error(`${keyOf(device)} already captured by this orchestration${where}`);
    }
    const { env, host, devices: _devices, ...rest } = options;
    const to = target({ env, host }, s.invocation);
    const screenshotsDir = resolve(configDir, options.screenshotsDir ?? s.config.screenshotsDir);
    const dirOf = (device: string): string => join(screenshotsDir, s.run, sequence, device);
    const origin: Origin = {
      configFile: canonical(s.configFile),
      sequencesDir: canonical(checked.sequencesDir),
      sequenceFile: canonical(checked.file),
      screenshotsDir: canonical(screenshotsDir),
    };
    const fingerprint = (device: string): string => JSON.stringify([rest, checked.devices[device], playwright, to]);
    const showEnv = to.env !== undefined && to.env !== (options.defaultEnv ?? s.config.defaultEnv);
    // The longest device name any call could show; with the widest ` (<env>)`, every child pads its rows the same.
    const widest = [...Object.keys(s.config.devices), ...checked.deviceOrder].reduce((a, b) => (b.length > a.length ? b : a));
    const envs = [...(Object.keys(s.config.envs).length > 1 ? Object.keys(s.config.envs) : []), ...(showEnv ? [to.env!] : [])];
    const width = Math.max(...[...ids, sequence].flatMap((id) => [undefined, ...envs].map((env) => rowLabel(id, widest, env).length)));

    // Each device: the accepted capture of a failed call being retried, the run's cache for a part the filters
    // leave out, or a shoot.
    const result = new Map<string, Capture>();
    for (const device of checked.deviceOrder) {
      const key = keyOf(device);
      const match = filtering(s.filters) && matches(s.filters, sequence, device, checked.file);
      if (match) {
        state.matched = true;
        for (const word of selecting(s.filters, sequence, checked.file)) state.hit.add(word);
      }
      // Through the same checks as a filtered reuse: a file the failed call's cleanup removed means a reshoot.
      let reuse = held.get(key) === fingerprint(device) ? reusable(cache, key, origin) : undefined;
      if (!reuse && filtering(s.filters) && !match) {
        reuse = reusable(cache, key, origin);
        if (!reuse) partLine(s.out, "+", rowLabel(sequence, device, showEnv ? to.env : undefined), width, "building, no capture yet");
      }
      if (reuse) {
        result.set(device, { ...reuse, reused: true });
        partLine(s.out, "=", rowLabel(sequence, device, showEnv ? reuse.env : undefined), width, `reused  ${shotCount(reuse.shots.length)}`);
      }
    }

    const order = checked.deviceOrder.filter((d) => !result.has(d));
    if (order.length > 0) {
      for (const device of order) delete cache.entries[keyOf(device)];
      saveCache(s.cacheFile, cache);
      const requestFile = join(cacheDir(configDir), "requests", `${process.pid}-${++requests}.json`);
      mkdirSync(dirname(requestFile), { recursive: true });
      const body = {
        sequence,
        file: checked.file,
        configDir,
        snapseq: rest,
        devices: order.map((d) => [d, checked.devices[d]!]),
        playwright,
        rows: { labelWidth: width, showEnv },
      } satisfies Request;
      writeFileSync(requestFile, `${JSON.stringify(body, null, 2)}\n`);
      let closed: Closed;
      try {
        call.child = spawnChild(s.command, childEnv(requestFile, to));
        closed = await call.child.closed;
      } finally {
        rmSync(requestFile, { force: true });
      }
      const { accepted, report, problem } = judge(sequence, order, closed, dirOf);
      for (const t of report?.tests ?? []) state.tally[t.status] = (state.tally[t.status] ?? 0) + 1;
      // Whole, and even when a sibling failed: a retry of this call reshoots only what failed.
      for (const [device, capture] of accepted) cache.entries[keyOf(device)] = { ...origin, capture };
      if (accepted.size > 0) saveCache(s.cacheFile, cache);
      if (problem !== undefined) {
        for (const device of accepted.keys()) held.set(keyOf(device), fingerprint(device));
        throw new Error(`${problem}${where}`);
      }
      for (const [device, capture] of accepted) result.set(device, { ...capture, reused: false });
    }

    const captures = checked.deviceOrder.map((d) => result.get(d)!);
    for (const c of captures) {
      claims.add(keyOf(c.device));
      state.shots += c.shots.length;
      if (c.reused) state.tally.reused = (state.tally.reused ?? 0) + 1;
    }
    return captures;
  }

  function childEnv(requestFile: string, to: Target): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, SNAPSEQ_REQUEST_FILE: requestFile, SNAPSEQ_RUN: s.run };
    delete env.SNAPSEQ_ENV;
    delete env.SNAPSEQ_HOST;
    if (to.env !== undefined) env.SNAPSEQ_ENV = to.env;
    if (to.host !== undefined) env.SNAPSEQ_HOST = to.host;
    if (s.record !== undefined) env.SNAPSEQ_RECORD = s.record;
    return env;
  }

  /** No further child; the current one is interrupted and awaited with its cleanup. */
  async function stop(): Promise<void> {
    state.stopped = true;
    const call = state.active;
    if (!call?.promise) return;
    // Also marks it handled: a run nobody awaited must not surface as an unhandled rejection after exit.
    const settled = call.promise.then(
      () => {},
      () => {},
    );
    if (call.child) await call.child.stop();
    await settled;
  }

  return { run, stop, state };
}
