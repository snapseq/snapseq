// run(): one sequence, now, in a child `playwright test`. The parent's half of protocol.md and the run()
// semantics table: validate, reuse what may be reused, spawn for the rest, accept per capture and per call.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import { rowLabel } from "../row-label.js";
import { type CachedCapture, type Origin, type RunCache, cacheDir, canonical, isFile, reusable, saveCache } from "./cache.js";
import { type Filters, filtering, matches } from "./filters.js";
import { type Child, type Closed, spawnChild } from "./spawn.js";
import { stopChild } from "./stop.js";
import { type Out, partLine, plural } from "./terminal.js";
import type { Capture, CaptureShot, ResolvedSnapseqConfig, RunOptions } from "./types.js";
import { type Checked, checkRun, isDirName } from "./validate.js";

export interface Target {
  env?: string;
  host?: string;
}

/** What every run() of one orchestration shares. */
export interface Session {
  config: ResolvedSnapseqConfig;
  overrides: readonly PlaywrightTestConfig[];
  /** Absolute. */
  configFile: string;
  run: string;
  /** `--env`/`--host`, or the SNAPSEQ_ENV/SNAPSEQ_HOST snapseq started with: over every run's own. */
  invocation: Target;
  /** `--record`: becomes SNAPSEQ_RECORD in each child. */
  record?: string;
  filters: Filters;
  cacheFile: string;
  cache: RunCache;
  /** The child's argv: node, Playwright's CLI, `test -c <config>`, the pass-through flags. */
  command: readonly string[];
  /** The ids in the sequences folder, read once, so rows line up across children. */
  sequenceIds: readonly string[];
  out: Out;
}

interface Entry {
  device: string;
  status: string;
  retry: number;
  usedSeq: boolean;
  skipReason: string | null;
  error: string | null;
  capture: CachedCapture | null;
}

interface Report {
  version: 1;
  status: string;
  errors: string[];
  tests: Entry[];
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
    const at = text.endsWith(")") ? text.slice(text.lastIndexOf("(") + 1, -1) : text.replace(/^at (?:async )?/, "");
    const m = /^(.*):(\d+):\d+$/.exec(at);
    if (!m) continue;
    const file = m[1]!.startsWith("file://") ? fileURLToPath(m[1]!) : m[1]!;
    if (isAbsolute(file) && !file.startsWith(OWN)) return `${basename(file)}:${m[2]}`;
  }
  return undefined;
}

/**
 * Layers from low to high: config, the run's options, the invocation. An env at a layer resets the host to that
 * env's own; a host at the same layer wins over it. Only explicit values come out: the child resolves the rest,
 * so the parent never makes up a host.
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
    if (r?.version === 1 && typeof r.status === "string" && Array.isArray(r.errors) && Array.isArray(r.tests)) return r;
  } catch {}
  return undefined;
}

/** Why a passed entry's capture cannot be used as it is, or undefined when it can. */
function captureProblem(entry: Entry, sequence: string, dir: string): string | undefined {
  const c = entry.capture;
  if (entry.error !== null) return entry.error;
  if (!c || typeof c !== "object") return "no capture";
  if (c.sequence !== sequence || c.device !== entry.device) return `a capture of ${c.sequence}/${c.device}`;
  if (typeof c.dir !== "string" || canonical(c.dir) !== canonical(dir)) return `shots in ${c.dir}, not ${dir}`;
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
 * The two predicates of protocol.md: which captures are good on their own (cached even when a sibling failed),
 * and whether the call resolves; when it does not, the semantics table's words for why.
 */
function judge(sequence: string, order: readonly string[], closed: Closed, dirOf: (device: string) => string) {
  const accepted = new Map<string, CachedCapture>();
  const report = parseReport(closed);
  if (!report) {
    const why = closed.incomplete ? ` (${closed.incomplete})` : "";
    return { accepted, report, problem: `${sequence}: child exited before reporting${why}; see the output above` };
  }
  const failed: string[] = [];
  const notRun: string[] = [];
  const unused: string[] = [];
  const retried: string[] = [];
  const other: string[] = [];
  let most = 0;
  for (const device of order) {
    const entries = report.tests.filter((t) => t.device === device);
    most = Math.max(most, entries.length);
    const e = entries[0];
    if (!e) notRun.push(device);
    else if (entries.length > 1) continue;
    else if (e.retry !== 0) retried.push(device);
    else if (e.status === "passed" && !e.usedSeq) unused.push(device);
    else if (e.status === "passed") {
      const why = captureProblem(e, sequence, dirOf(device));
      if (why !== undefined) other.push(`reported no usable capture on ${device}: ${firstLine(why)}`);
      else if (report.status !== "interrupted") accepted.set(device, e.capture!);
    } else if (e.status === "skipped") other.push(`was skipped on ${device}${e.skipReason ? `: "${e.skipReason}"` : ""}`);
    else if (e.status === "not run") notRun.push(device);
    else failed.push(device);
  }
  const strangers = report.tests.map((t) => t.device).filter((d) => !order.includes(d));
  const blame = [
    failed.length > 0 ? `failed on ${failed.join(", ")}` : "",
    ...other,
    unused.length > 0 ? `never used seq on ${unused.join(", ")}` : "",
    retried.length > 0 ? `was retried on ${retried.join(", ")}; retries must be 0` : "",
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
  /** `<sequence>/<device>` this orchestration already got back from a run(), reused ones included. */
  const claims = new Set<string>();
  /** Accepted captures of a failed call, for its retry. */
  const held = new Map<string, { capture: CachedCapture; fingerprint: string }>();
  const state = {
    active: undefined as Call | undefined,
    stopped: false,
    /** A part matched the filters; a part built only because there was nothing to reuse does not count. */
    matched: false,
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
    call.promise = execute(call, sequence, options, playwright, where).finally(() => {
      if (state.active === call) state.active = undefined;
    });
    return call.promise;
  }

  async function execute(
    call: Call,
    sequence: string,
    options: RunOptions,
    playwright: PlaywrightTestConfig[],
    where: string,
  ): Promise<readonly Capture[]> {
    let checked: Checked;
    try {
      checked = checkRun(sequence, options, playwright, {
        config: s.config,
        configDir,
        overrides: s.overrides,
        invocationEnv: s.invocation.env,
      });
    } catch (err) {
      throw new Error(`${String(sequence)}: ${(err as Error).message}${where}`);
    }
    const keyOf = (device: string): string => `${sequence}/${device}`;
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
    // The widest label the children could print, as the reporter builds it.
    const widest = [...Object.keys(s.config.devices), ...checked.deviceOrder].reduce((a, b) => (b.length > a.length ? b : a));
    const width = Math.max(...[...s.sequenceIds, sequence].map((id) => rowLabel(id, widest, showEnv ? to.env : undefined).length));

    // Each device: the accepted capture of a failed call being retried, the run's cache for a part the filters
    // leave out, or a shoot.
    const result = new Map<string, Capture>();
    for (const device of checked.deviceOrder) {
      const key = keyOf(device);
      const match = filtering(s.filters) && matches(s.filters, sequence, device);
      if (match) state.matched = true;
      const kept = held.get(key);
      let reuse = kept?.fingerprint === fingerprint(device) ? kept.capture : undefined;
      if (!reuse && filtering(s.filters) && !match) {
        reuse = reusable(s.cache, key, origin);
        if (!reuse) partLine(s.out, rowLabel(sequence, device, showEnv ? to.env : undefined), width, "building, no capture yet");
      }
      if (reuse) {
        result.set(device, { ...reuse, reused: true });
        partLine(s.out, rowLabel(sequence, device, showEnv ? reuse.env : undefined), width, `reused  ${plural(reuse.shots.length)}`);
      }
    }

    const order = checked.deviceOrder.filter((d) => !result.has(d));
    if (order.length > 0) {
      for (const device of order) {
        delete s.cache.entries[keyOf(device)];
        held.delete(keyOf(device));
      }
      saveCache(s.cacheFile, s.cache);
      const request = join(cacheDir(configDir), "requests", `${process.pid}-${++requests}.json`);
      mkdirSync(dirname(request), { recursive: true });
      const body = {
        version: 1,
        sequence,
        file: checked.file,
        snapseq: { ...rest, devices: Object.fromEntries(order.map((d) => [d, checked.devices[d]])) },
        deviceOrder: order,
        playwright,
        terminal: { labelWidth: width, showEnv },
      };
      writeFileSync(request, `${JSON.stringify(body, null, 2)}\n`);
      let closed: Closed;
      try {
        call.child = spawnChild(s.command, childEnv(request, to));
        closed = await call.child.closed;
      } finally {
        rmSync(request, { force: true });
      }
      const { accepted, report, problem } = judge(sequence, order, closed, dirOf);
      for (const t of report?.tests ?? []) state.tally[t.status] = (state.tally[t.status] ?? 0) + 1;
      // Whole, and even when a sibling failed: a retry of this call reshoots only what failed.
      for (const [device, capture] of accepted) s.cache.entries[keyOf(device)] = { ...origin, capture };
      if (accepted.size > 0) saveCache(s.cacheFile, s.cache);
      if (problem !== undefined) {
        for (const [device, capture] of accepted) held.set(keyOf(device), { capture, fingerprint: fingerprint(device) });
        throw new Error(`${problem}${where}`);
      }
      for (const [device, capture] of accepted) result.set(device, { ...capture, reused: false });
    }

    const captures = checked.deviceOrder.map((d) => result.get(d)!);
    for (const c of captures) {
      claims.add(keyOf(c.device));
      held.delete(keyOf(c.device));
      state.shots += c.shots.length;
      if (c.reused) state.tally.reused = (state.tally.reused ?? 0) + 1;
    }
    return captures;
  }

  function childEnv(request: string, to: Target): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, SNAPSEQ_OVERRIDES_FILE: request, SNAPSEQ_RUN: s.run, SNAPSEQ_OPEN: "0" };
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
    if (call.child) await stopChild(call.child);
    await settled;
  }

  return { run, stop, state };
}
