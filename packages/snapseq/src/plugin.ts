import type { SequenceContext } from "./fixtures.js";
import type { ShotFormat, SnapOptions } from "./sequence.js";

/**
 * One screenshot of the sequence: still to be taken in `beforeSnap`, written
 * in `afterSnap`. `name`, `path`, `index` and `format` belong to the sequence;
 * a hook must not change them.
 */
export interface Shot {
  /** File name, e.g. `01.png`. */
  name: string;
  /** Absolute path of the file. */
  path: string;
  /** The page URL at screenshot time; in `beforeSnap`, the URL when the snap started. */
  url: string;
  /** Position in the sequence, from 1. */
  index: number;
  /** What the sequence passed to `snap` or `snapPage`, plugin keys included. A `beforeSnap` hook may edit it. */
  options: SnapOptions;
  /**
   * The shot's notes, printed with it in the terminal: what `beforeSnap` hooks pushed, in order, then the readiness caps
   * that ran out, e.g. `2 images still loading after 5 s (first: …)`. Each is cleaned (control, format and line-separator
   * characters to spaces, trimmed, at most 200 characters) and listed once. In `beforeSnap`, what earlier hooks pushed.
   */
  notes: string[];
  /** The config's `format`: Playwright's screenshot `type` and `quality`. `{}` is PNG. */
  format: ShotFormat;
  /**
   * From `afterSnap` on, the file's pixels per CSS pixel: e.g. `2` on a 2x phone, `1` for a shot with `scale: "css"`.
   * In `beforeSnap` it is the device option's ratio, the page's as a fallback, and provisional, as a hook may
   * still set `scale`.
   */
  deviceScaleFactor: number;
}

/**
 * An addon listed in the config's `plugins`. Hooks run in the worker, inside
 * the sequence, in the order the plugins are listed; a hook that throws fails
 * the sequence. A factory must be pure: Playwright evaluates the config, and
 * so the factory, in every process it starts.
 */
export interface Plugin {
  name: string;
  /** The page exists and the sequence body has not run: cookies, headers, init scripts, routes, viewport, emulateMedia, persistent CSS. */
  begin?(ctx: SequenceContext): Promise<void>;
  /** At the start of `snap` and `snapPage`, before the readiness wait and before `snapPage` grows the viewport. No file yet. May change the page, edit `shot.options`, or push to `shot.notes`. */
  beforeSnap?(shot: Shot, ctx: SequenceContext): Promise<void>;
  /** After the file is written and before the shot joins `seq.shots`. May rewrite the file in place. */
  afterSnap?(shot: Shot, ctx: SequenceContext): Promise<void>;
  /** After the sequence body passed, with every shot in order, before the page closes. */
  done?(shots: readonly Shot[], ctx: SequenceContext): Promise<void>;
  /** After the sequence body failed or timed out and `failed.png` was attempted, with the shots listed so far. */
  failed?(shots: readonly Shot[], ctx: SequenceContext): Promise<void>;
}
