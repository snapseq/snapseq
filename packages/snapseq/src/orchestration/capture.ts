import type { TestInfo } from "@playwright/test";
import type { Shot, SnapOptions } from "../sequence.js";
import type { Capture, CaptureShot } from "./types.js";
import { isPlainObject } from "./validate.js";

const DROP = Symbol("drop");

// Strings, finite numbers, booleans, null, and plain objects and arrays of those, copied; anything else (a Locator, a
// function, undefined, NaN, a Date, a RegExp, a bigint, a reference back to an object it is inside) left out, without
// calling its toJSON.
const json = (value: unknown, ancestors: readonly object[] = []): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : DROP;
  if (typeof value !== "object" || ancestors.includes(value)) return DROP;
  const inside = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => json(item, inside)).filter((item) => item !== DROP);
  if (!isPlainObject(value)) return DROP;
  const entries = Object.entries(value).map(([key, item]) => [key, json(item, inside)] as const);
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

/**
 * Attaches the capture a passed sequence hands the orchestration parent as `snapseq-capture`, each shot field by field:
 * at most 1 MiB of JSON, paths and options, never the images.
 */
export async function attachCapture(testInfo: TestInfo, part: Omit<Capture, "reused" | "shots">, shots: readonly Shot[]): Promise<void> {
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
        // What the file is: the config's `{}` is a PNG.
        format: { ...shot.format, type: shot.format.type ?? "png" },
        options: shot.given,
      }),
    ),
  });
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("snapseq: capture metadata over 1 MiB");
  await testInfo.attach("snapseq-capture", { contentType: "application/json", body });
}
