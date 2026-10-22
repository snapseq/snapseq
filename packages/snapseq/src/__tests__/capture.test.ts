import type { TestInfo } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { attachCapture, snapshot } from "../orchestration/capture.js";
import type { Shot, SnapOptions } from "../sequence.js";

const part = { sequence: "campaign/pricing", device: "desktop", env: "uat", host: "https://uat.example.com", dir: "/abs/out/r/campaign/pricing/desktop" };

const shot = (over: Partial<Shot> = {}): Shot => ({
  name: "01.png",
  path: `${part.dir}/01.png`,
  url: "https://uat.example.com/pricing",
  index: 1,
  options: { animations: "disabled" }, // what stabilize set for the screenshot
  given: { label: "Pricing" } as SnapOptions, // label: the label step's augmentation
  notes: ["1 image still loading after 5 s"],
  format: {},
  deviceScaleFactor: 2,
  ...over,
});

describe("snapshot", () => {
  it("copies what survives JSON as itself, leaves out the rest and mask, and calls no toJSON", () => {
    const odd = new (class Odd {
      toJSON(): never {
        throw new Error("called");
      }
    })();
    const options = {
      label: "Hero",
      timeout: 3_000,
      omitBackground: true,
      mask: [{ selector: "#ad" }], // plain, and still left out: a mask is the page's locators
      clip: { x: 0, y: 0, width: 10, height: Number.NaN },
      style: undefined,
      nested: { list: [1, "a", null, undefined, () => {}, { ok: true }, new Date(0), /x/], big: 1n, odd },
      plain: Object.assign(Object.create(null), { a: 1 }),
    } as unknown as SnapOptions;
    const copy = snapshot(options);
    expect(copy).toEqual({
      label: "Hero",
      timeout: 3_000,
      omitBackground: true,
      clip: { x: 0, y: 0, width: 10 },
      nested: { list: [1, "a", null, { ok: true }] },
      plain: { a: 1 },
    });
    expect(Object.keys(copy)).not.toContain("style");
    (options as { clip: { x: number } }).clip.x = 99;
    expect(copy.clip?.x).toBe(0); // deep: a later change to the caller's object does not reach it
    expect(snapshot(undefined)).toEqual({});
  });

  it("leaves out a reference back to an object it is inside, and keeps one that only repeats", () => {
    const shared = { ok: true };
    const options = { label: { text: "Hero" }, list: [shared, shared] } as Record<string, unknown>;
    (options.label as Record<string, unknown>).self = options.label;
    (options.list as unknown[]).push(options.list);
    expect(snapshot(options as SnapOptions)).toEqual({ label: { text: "Hero" }, list: [{ ok: true }, { ok: true }] });
  });
});

/** attachCapture with a stand-in testInfo; resolves to the body it attached, parsed. */
async function attached(shots: Shot[]) {
  const attach = vi.fn(async (_name: string, _options: { contentType: string; body: string }) => {});
  await attachCapture({ attach } as unknown as TestInfo, part, shots);
  expect(attach).toHaveBeenCalledTimes(1);
  const [name, options] = attach.mock.calls[0]!;
  expect([name, options.contentType]).toEqual(["snapseq-capture", "application/json"]);
  return JSON.parse(options.body) as unknown;
}

describe("attachCapture", () => {
  it("builds the capture field by field: the options the sequence gave, the format as the file is", async () => {
    const capture = await attached([shot(), shot({ index: 2, name: "02.jpg", path: `${part.dir}/02.jpg`, format: { type: "jpeg", quality: 70 }, given: {}, notes: [] })]);
    expect(capture).toStrictEqual({
      ...part,
      shots: [
        {
          index: 1,
          name: "01.png",
          path: `${part.dir}/01.png`,
          url: "https://uat.example.com/pricing",
          notes: ["1 image still loading after 5 s"],
          deviceScaleFactor: 2,
          format: { type: "png" },
          options: { label: "Pricing" },
        },
        {
          index: 2,
          name: "02.jpg",
          path: `${part.dir}/02.jpg`,
          url: "https://uat.example.com/pricing",
          notes: [],
          deviceScaleFactor: 2,
          format: { type: "jpeg", quality: 70 },
          options: {},
        },
      ],
    });
  });

  it("fails the sequence over 1 MiB, attaching nothing", async () => {
    const attach = vi.fn(async () => {});
    const big = shot({ given: { label: "x".repeat(1024 * 1024) } as SnapOptions });
    await expect(attachCapture({ attach } as unknown as TestInfo, part, [big])).rejects.toThrow("snapseq: capture metadata over 1 MiB");
    expect(attach).not.toHaveBeenCalled();
  });
});
