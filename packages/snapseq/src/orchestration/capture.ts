import type { TestInfo } from "@playwright/test";
import type { Shot, SnapOptions } from "../sequence.js";
import type { Capture, CaptureShot } from "./types.js";

const DROP = Symbol("drop");

// Strings, finite numbers, booleans, null, and plain objects and arrays of those, copied; anything else (a Locator, a
// function, undefined, NaN, a Date, a RegExp, a bigint) left out, without calling its toJSON.
const json = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : DROP;
  if (Array.isArray(value)) return value.map(json).filter((item) => item !== DROP);
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) return DROP;
  const entries = Object.entries(value as object).map(([key, item]) => [key, json(item)] as const);
  return Object.fromEntries(entries.filter(([, item]) => item !== DROP));
};

/**
 * What the sequence passed to `snap` or `snapPage`, as JSON, taken when the shot opens: a deep copy, so neither
 * stabilize nor a later change to the caller's object reaches it. `mask` is left out: its locators are the page's.
 */
export function snapshot(options: SnapOptions | undefined): SnapOptions {
  const { mask: _mask, ...rest } = options ?? {};
  return json(rest) as SnapOptions;
}

/** The capture a passed sequence attaches for the orchestration parent, each shot field by field. */
export function captureOf(
  part: { sequence: string; device: string; env: string; host: string; dir: string },
  shots: readonly Shot[],
): Omit<Capture, "reused"> {
  return {
    sequence: part.sequence,
    device: part.device,
    env: part.env,
    host: part.host,
    dir: part.dir,
    shots: shots.map(
      (shot): CaptureShot => ({
        index: shot.index,
        name: shot.name,
        path: shot.path,
        url: shot.url,
        notes: [...shot.notes],
        deviceScaleFactor: shot.deviceScaleFactor,
        // What the file is: the config's `{}` is a PNG.
        format: { ...shot.format, type: shot.format.type ?? "png" },
        options: shot.given,
      }),
    ),
  };
}

/** Attaches the capture as `snapseq-capture`, at most 1 MiB of JSON: paths and options, never the images. */
export async function attachCapture(
  testInfo: TestInfo,
  part: Parameters<typeof captureOf>[0],
  shots: readonly Shot[],
): Promise<void> {
  const body = JSON.stringify(captureOf(part, shots));
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("snapseq: capture metadata over 1 MiB");
  await testInfo.attach("snapseq-capture", { contentType: "application/json", body });
}
