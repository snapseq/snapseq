import type { PlaywrightTestConfig } from "@playwright/test";
import type { DeviceConfig, SnapseqConfig } from "../define.js";
import type { SnapOptions } from "../sequence.js";

/** One shot as the orchestration sees it: the file plus what the worker knew when it took it. */
export interface CaptureShot {
  readonly index: number;
  /** File name, e.g. `01.png`. */
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
  /** The page URL when the shot was taken. */
  readonly url: string;
  /** Readiness notes, e.g. an image still loading. */
  readonly notes: readonly string[];
  readonly deviceScaleFactor: number;
  readonly format: { readonly type: "png" | "jpeg"; readonly quality?: number };
  /** What `snap()` or `snapPage()` was called with, JSON parts only; a `label` lives here. */
  readonly options: Readonly<SnapOptions>;
}

/** One sequence on one device: what `run()` resolves to, one per device. */
export interface Capture {
  /** The sequence id, e.g. `12345-spring-launch`; a nested one keeps its slashes. */
  readonly sequence: string;
  readonly device: string;
  readonly env: string;
  readonly host: string;
  /** Absolute directory the shots are in. */
  readonly dir: string;
  /** Not shot by this call: it came from the run's cache, as a part the filters leave out or a device that passed in a failed call being retried. */
  readonly reused: boolean;
  readonly shots: readonly CaptureShot[];
}

/**
 * A snapseq config fragment for one run: each key given replaces the default
 * from `snapseq.config`. `devices` also takes names, which pick those devices
 * from the defaults in that order. Values must be plain JSON: they travel to a
 * separate Playwright process.
 */
export type RunOptions = Partial<Omit<SnapseqConfig, "devices">> & {
  devices?: readonly string[] | Readonly<Record<string, DeviceConfig>>;
  /** An env name from `envs`; resets the host to that env's host. `--env` on the command line still wins. */
  env?: string;
  /** Over the env's host, like `--host`. */
  host?: string;
};

/** The defaults from `snapseq.config`, resolved, as handed to an orchestration. */
export type ResolvedSnapseqConfig = Required<SnapseqConfig>;

export interface OrchestrationContext {
  /**
   * Run one sequence now with these settings; Playwright overrides merge after,
   * as in `defineConfig`. One call at a time. Resolves to one capture per
   * device, in device order; rejects when any device did not produce one.
   */
  run(sequence: string, options?: RunOptions, ...playwright: PlaywrightTestConfig[]): Promise<readonly Capture[]>;
  /** The resolved defaults from `snapseq.config`. */
  readonly config: ResolvedSnapseqConfig;
  /** This run's absolute directory, e.g. `…/screenshots/review-1`. */
  readonly dir: string;
}

export type Orchestration = (ctx: OrchestrationContext) => Promise<unknown>;

/** Identity, for the types: `export default defineOrchestration(async ({ run, config, dir }) => { … })`. */
export function defineOrchestration(fn: Orchestration): Orchestration {
  return fn;
}
