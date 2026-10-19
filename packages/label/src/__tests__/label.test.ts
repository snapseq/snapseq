import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { CaptureContext, ShotFormat, SnapOptions } from "snapseq";
import { afterEach, describe, expect, it } from "vitest";
import { label, type LabelOptions } from "../index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "label-"));
  dirs.push(dir);
  return dir;
};

// A red source image, or a transparent one, as PNG (RGBA, or RGB for "rgb") or JPEG.
async function source(dir: string, name: string, width = 200, height = 100, kind: "png" | "rgb" | "jpeg" | "clear" = "png") {
  const path = join(dir, name);
  const background = kind === "clear" ? { r: 0, g: 0, b: 0, alpha: 0 } : "#ff0000";
  const img = sharp({ create: { width, height, channels: kind === "jpeg" || kind === "rgb" ? 3 : 4, background } });
  await (kind === "jpeg" ? img.jpeg() : img.png()).toFile(path);
  return path;
}

// Runs the plugin on one shot: the factory's options, the shot's label, and its format and device scale factor.
async function run(
  dir: string,
  path: string,
  text: SnapOptions["label"],
  { plugin = {}, format = {}, dsf = 1 }: { plugin?: LabelOptions; format?: ShotFormat; dsf?: number } = {},
) {
  const ctx = { seq: { dir } } as unknown as CaptureContext;
  const shot = { name: "", path, url: "", index: 1, options: { label: text }, notes: [], format, deviceScaleFactor: dsf };
  await label(plugin).afterSnap!(shot, ctx);
}

// Decodes the file to RGBA and reads pixels back.
async function look(file: string, points: [number, number][] = []) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
  return {
    width: info.width,
    height: info.height,
    at: points.map(([x, y]) => px(x, y)),
    // the pixels in columns x0 to x1 and rows y0 to y1, ends included
    box: (x0: number, x1: number, y0: number, y1: number) =>
      Array.from({ length: (y1 - y0 + 1) * (x1 - x0 + 1) }, (_, i) => px(x0 + (i % (x1 - x0 + 1)), y0 + Math.floor(i / (x1 - x0 + 1)))),
    // any pixel in the top 24 rows darker than 200: the text was drawn
    inked: Array.from(data.subarray(0, info.width * 24 * 4)).some((v, i) => i % 4 !== 3 && v < 200),
  };
}

describe("label", () => {
  it("adds a 24 px strip with the text above a native-size image", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "0.0 Home");
    const seen = await look(path, [[100, 2], [100, 60]]);
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
    expect(seen.inked).toBe(true);
    expect(readdirSync(dir)).toEqual(["01.png"]);
  });

  it("keeps a 2x shot at its pixels", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    await run(dir, path, "2x", { dsf: 2 });
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([400, 224]);
  });

  it("writes a JPEG when the format is jpeg", async () => {
    const dir = tmp();
    const path = await source(dir, "01.jpg", 200, 100, "jpeg");
    await run(dir, path, "jpeg", { format: { type: "jpeg", quality: 50 } });
    expect([...readFileSync(path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  it("does nothing without a label", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const before = readFileSync(path);
    await run(dir, path, undefined);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("draws a label with control characters and lone surrogates as spaces", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "a\vb\x1bc\ufffed\ud800e");
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.inked).toBe(true);
  });

  it("renders the label as text, not markup", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "<b>&");
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  it("keeps a transparent shot transparent; only the strip is white", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 200, 100, "clear");
    await run(dir, path, "0.0 Home");
    const seen = await look(path, [[100, 2], [100, 60]]);
    expect(seen.height).toBe(124);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]); // the strip, opaque white
    expect(seen.at[1]![3]).toBe(0); // the image area, still transparent
    expect((await sharp(path).metadata()).channels).toBe(4);
  });

  it("keeps an RGB shot RGB", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 200, 100, "rgb");
    await run(dir, path, "0.0 Home");
    expect((await sharp(path).metadata()).channels).toBe(3);
    const seen = await look(path, [[100, 2], [100, 60]]);
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
  });

  it("draws the dark theme: black strip, light ink, image untouched", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "0.0 Home", { plugin: { theme: "dark" } });
    const seen = await look(path, [[100, 2], [100, 60]]);
    expect(seen.at[0]).toEqual([0, 0, 0, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
    expect(seen.box(0, 199, 0, 23).some((p) => p.some((v, i) => i < 3 && v > 100))).toBe(true);
  });

  it("lets the shot's style beat the factory's", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, { text: "0.0 Home", theme: "light" }, { plugin: { theme: "dark" } });
    const seen = await look(path, [[100, 2]]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.inked).toBe(true);
  });

  it("lets an explicit color beat the theme at the same level", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "0.0 Home", { plugin: { theme: "dark", background: "#f00" } });
    const seen = await look(path, [[100, 2]]);
    expect(seen.at[0]).toEqual([255, 0, 0, 255]);
    // white ink on red lifts the green or blue channel
    expect(seen.box(0, 199, 0, 23).some((p) => p[1]! > 100 || p[2]! > 100)).toBe(true);
  });

  it("centers a short label", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "0.0 Home");
    const seen = await look(path);
    expect(seen.box(0, 39, 0, 23).every((p) => p.join() === "255,255,255,255")).toBe(true);
  });

  it("cuts a long label at the end, not the start", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "W".repeat(200));
    const seen = await look(path);
    const bare = (x0: number, x1: number) => seen.box(x0, x1, 0, 23).every((p) => p.join() === "255,255,255,255");
    expect(bare(0, 7)).toBe(true);
    expect(bare(8, 40)).toBe(false);
    expect(bare(180, 199)).toBe(false);
  });

  it("cuts a label of thousands of characters at the end, not the start", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    await run(dir, path, "W".repeat(5000));
    const seen = await look(path);
    const bare = (x0: number, x1: number) => seen.box(x0, x1, 0, 23).every((p) => p.join() === "255,255,255,255");
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(bare(0, 7)).toBe(true);
    expect(bare(8, 40)).toBe(false);
    expect(bare(180, 199)).toBe(false);
  });

  it.each([0, -1, NaN, Infinity])("rejects a scale of %s", async (value) => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const before = readFileSync(path);
    await expect(run(dir, path, "0.0 Home", { plugin: { scale: () => value } })).rejects.toThrow(
      `snapseq-label: scale must be a positive number, got ${value}`,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("scales the strip with the device scale factor when scale is true", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    await run(dir, path, "0.0 Home", { plugin: { scale: true }, dsf: 2 });
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([400, 248]);
    expect(seen.box(0, 399, 24, 47).some((p) => p.join() !== "255,255,255,255")).toBe(true);
  });

  it("maps the device scale factor with a scale function", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    await run(dir, path, "0.0 Home", { plugin: { scale: (d) => d / 2 }, dsf: 4 });
    const seen = await look(path);
    expect([seen.width, seen.height]).toEqual([400, 248]);
  });
});
