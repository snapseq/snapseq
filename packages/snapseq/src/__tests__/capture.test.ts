import type { TestInfo } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { attachCapture, captureOf, snapshot } from "../orchestration/capture.js";
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
});

describe("captureOf", () => {
  it("builds the capture field by field: the options the sequence gave, the format as the file is", () => {
    const capture = captureOf(part, [shot(), shot({ index: 2, name: "02.jpg", path: `${part.dir}/02.jpg`, format: { type: "jpeg", quality: 70 }, given: {}, notes: [] })]);
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
});

describe("attachCapture", () => {
  it("attaches the capture as JSON, and fails the sequence over 1 MiB", async () => {
    const attach = vi.fn(async () => {});
    const testInfo = { attach } as unknown as TestInfo;
    await attachCapture(testInfo, part, [shot()]);
    expect(attach).toHaveBeenCalledWith("snapseq-capture", { contentType: "application/json", body: JSON.stringify(captureOf(part, [shot()])) });
    const big = shot({ given: { label: "x".repeat(1024 * 1024) } as SnapOptions });
    await expect(attachCapture(testInfo, part, [big])).rejects.toThrow("snapseq: capture metadata over 1 MiB");
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
