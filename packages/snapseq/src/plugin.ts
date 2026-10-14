import type { CaptureContext } from "./fixtures.js";
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
  /** Position in the capture, from 1. */
  index: number;
  /** What the capture passed to `snap` or `snapPage`, plugin keys included. A `beforeSnap` hook may edit it. */
  options: SnapOptions;
  /** Readiness caps that ran out before the shot, e.g. `2 images still loading after 5 s`. Empty in `beforeSnap`. */
  notes: string[];
  /** The config's `format`: Playwright's screenshot `type` and `quality`. `{}` is PNG. */
  format: ShotFormat;
  /** Device pixels per CSS pixel of the page, e.g. `2` on a 2x phone: the file is that many times the CSS size. */
  deviceScaleFactor: number;
}

/**
 * An addon listed in the config's `plugins`. Hooks run in the worker, inside
 * the capture, in the order the plugins are listed; a hook that throws fails
 * the capture. A factory must be pure: Playwright evaluates the config, and
 * so the factory, in every process it starts.
 */
export interface Plugin {
  name: string;
  /** The page exists and the capture body has not run: cookies, headers, init scripts, routes, viewport, emulateMedia, persistent CSS. */
  begin?(ctx: CaptureContext): Promise<void>;
  /** At the start of `snap` and `snapPage`, before the readiness wait and before `snapPage` grows the viewport. No file yet. May change the page, or edit `shot.options`. */
  beforeSnap?(shot: Shot, ctx: CaptureContext): Promise<void>;
  /** After the file is written and before it is listed in `shots.txt`. May rewrite the file in place. */
  afterSnap?(shot: Shot, ctx: CaptureContext): Promise<void>;
  /** After the capture body passed, with every shot in order, before the page closes. */
  done?(shots: readonly Shot[], ctx: CaptureContext): Promise<void>;
  /** After the capture body failed or timed out and `failed.png` was attempted, with the shots listed so far. */
  failed?(shots: readonly Shot[], ctx: CaptureContext): Promise<void>;
}
