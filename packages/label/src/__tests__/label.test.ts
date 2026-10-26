import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import type { Capture, CaptureShot, SnapOptions } from "snapseq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { label, type LabelOptions } from "../index.js";

type ShotFormat = CaptureShot["format"];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "label-"));
  dirs.push(dir);
  return dir;
};

// A red source image, or a transparent one, as PNG (RGBA, or RGB for "rgb").
async function source(dir: string, name: string, width = 200, height = 100, kind: "png" | "rgb" | "clear" = "png") {
  const path = join(dir, name);
  const background = kind === "clear" ? { r: 0, g: 0, b: 0, alpha: 0 } : "#ff0000";
  await sharp({ create: { width, height, channels: kind === "rgb" ? 3 : 4, background } }).png().toFile(path);
  return path;
}

// A capture of the given files, as the orchestration would hold it.
function capture(dir: string, files: { path: string; label?: SnapOptions["label"]; format?: ShotFormat; dsf?: number }[]): Capture {
  return {
    sequence: "12345-spring-launch",
    device: "desktop",
    env: "uat",
    host: "https://uat.example.com",
    dir,
    reused: false,
    shots: files.map(({ path, label, format = { type: "png" }, dsf = 1 }, i) => ({
      index: i + 1,
      name: basename(path),
      path,
      url: "https://uat.example.com/",
      notes: [],
      deviceScaleFactor: dsf,
      format,
      options: label === undefined ? {} : { label },
    })),
  };
}

// Runs the step on one shot: the step's options, the shot's label, format and device scale factor.
// Resolves to the labelled file.
async function run(
  path: string,
  text: SnapOptions["label"],
  { step = {}, format = { type: "png" }, dsf = 1 }: { step?: LabelOptions; format?: ShotFormat; dsf?: number } = {},
) {
  const [out] = await label([capture(dirname(path), [{ path, label: text, format, dsf }])], step);
  return out!.shots[0]!.path;
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
  it("writes labelled/<name> taller by a 24 px strip, leaves the raw shot alone, and returns the capture pointing there", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const raw = readFileSync(path);
    const input = capture(dir, [{ path, label: "0.0 Home" }]);
    const [out] = await label([input]);
    const file = join(dir, "labelled", "01.png");
    expect(out!.dir).toBe(join(dir, "labelled"));
    expect(out!.shots[0]!.path).toBe(file);
    const seen = await look(file, [[100, 2], [100, 60]]);
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
    expect(seen.inked).toBe(true);
    expect(readFileSync(path).equals(raw)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["01.png", "labelled"]);
    expect(readdirSync(join(dir, "labelled"))).toEqual(["01.png"]);
  });

  it("copies a shot whose label text is empty, without looking at scale", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const step = { scale: () => 0 };
    expect(readFileSync(await run(path, "", { step })).equals(readFileSync(path))).toBe(true);
    expect(readFileSync(await run(path, { text: "", theme: "dark" }, { step })).equals(readFileSync(path))).toBe(true);
  });

  it("writes the whole set and returns the capture with everything else unchanged", async () => {
    const dir = tmp();
    const a = await source(dir, "01.png");
    const b = await source(dir, "02.png");
    const input = capture(dir, [{ path: a, label: "0.0 Home" }, { path: b }]);
    const [out] = await label([input]);
    expect(readdirSync(join(dir, "labelled")).sort()).toEqual(["01.png", "02.png"]);
    expect((await look(out!.shots[0]!.path)).height).toBe(124);
    expect((await look(out!.shots[1]!.path)).height).toBe(100);
    expect(out).toEqual({
      ...input,
      dir: join(dir, "labelled"),
      shots: input.shots.map((shot) => ({ ...shot, path: join(dir, "labelled", shot.name) })),
    });
  });

  it("labels each capture into its own folder and returns them in order", async () => {
    const one = tmp();
    const two = tmp();
    const a = await source(one, "01.png");
    const b = await source(two, "01.png");
    const out = await label([capture(one, [{ path: a, label: "A" }]), { ...capture(two, [{ path: b, label: "B" }]), device: "mobile" }]);
    expect(out.map((c) => [c.device, c.dir])).toEqual([
      ["desktop", join(one, "labelled")],
      ["mobile", join(two, "labelled")],
    ]);
    expect(existsSync(join(one, "labelled", "01.png"))).toBe(true);
    expect(existsSync(join(two, "labelled", "01.png"))).toBe(true);
  });

  it("returns an empty array for no captures", async () => {
    expect(await label([])).toEqual([]);
  });

  it("writes over a file that is already in labelled/", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    mkdirSync(join(dir, "labelled"));
    writeFileSync(join(dir, "labelled", "01.png"), "stale");
    const seen = await look(await run(path, "0.0 Home"));
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  // As an encode interrupted halfway would leave it: part of a file, under the name it was writing.
  it("keeps the labelled file it had when writing a new one fails partway, and leaves no partial file", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const first = await run(path, "0.0 Home");
    const before = readFileSync(first);
    const toFile = vi.spyOn(sharp.prototype, "toFile").mockImplementation(async (file: unknown) => {
      writeFileSync(String(file), before.subarray(0, 10));
      throw new Error("encode failed");
    });
    try {
      await expect(run(path, "0.1 Home")).rejects.toThrow("encode failed");
    } finally {
      toFile.mockRestore();
    }
    expect(readFileSync(first).equals(before)).toBe(true);
    expect(readdirSync(join(dir, "labelled"))).toEqual(["01.png"]);
  });

  // numbering: "0".repeat(220) names a shot 224 bytes long; the file it is written through must fit beside it.
  it("labels a shot whose name is near the file system's limit", async () => {
    const dir = tmp();
    const path = await source(dir, `${"0".repeat(219)}1.png`);
    const seen = await look(await run(path, "0.0 Home"));
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  it("keeps a 2x shot at its pixels", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    const seen = await look(await run(path, "2x", { dsf: 2 }));
    expect([seen.width, seen.height]).toEqual([400, 224]);
  });

  it("writes a JPEG at the quality of the shot's format when the format is jpeg", async () => {
    const dir = tmp();
    const path = join(dir, "01.jpg");
    // noise, so the quality shows in the size
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg().toFile(path);
    const lowFile = await run(path, "q", { format: { type: "jpeg", quality: 10 } });
    const low = readFileSync(lowFile);
    const high = readFileSync(await run(path, "q", { format: { type: "jpeg", quality: 95 } })).length;
    expect([...low.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const seen = await look(lowFile);
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(low.length).toBeLessThan(high);
  });

  it.each([
    ["control characters and lone surrogates as spaces", "a\vb\x1bc\ufffed\ud800e"],
    ["markup as text", "<b>&"],
  ])("draws a label with %s", async (_, label) => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, label));
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.inked).toBe(true);
  });

  it("keeps a transparent shot transparent; only the strip is white", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 200, 100, "clear");
    const file = await run(path, "0.0 Home");
    const seen = await look(file, [[100, 2], [100, 60]]);
    expect(seen.height).toBe(124);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]); // the strip, opaque white
    expect(seen.at[1]![3]).toBe(0); // the image area, still transparent
    expect((await sharp(file).metadata()).channels).toBe(4);
  });

  it("keeps an RGB shot RGB", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 200, 100, "rgb");
    const file = await run(path, "0.0 Home");
    expect((await sharp(file).metadata()).channels).toBe(3);
    const seen = await look(file, [[100, 2], [100, 60]]);
    expect(seen.at).toEqual([[255, 255, 255, 255], [255, 0, 0, 255]]); // the strip white, the image still red
  });

  it("draws the dark theme: black strip, light ink, image untouched", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "0.0 Home", { step: { theme: "dark" } }), [[100, 2], [100, 60]]);
    expect(seen.at[0]).toEqual([0, 0, 0, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
    expect(seen.box(0, 199, 0, 23).some((p) => p.some((v, i) => i < 3 && v > 100))).toBe(true);
  });

  it("lets the shot's style beat the step's", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, { text: "0.0 Home", theme: "light" }, { step: { theme: "dark" } }), [[100, 2]]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.inked).toBe(true);
  });

  it("lets an explicit color beat the theme at the same level", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "0.0 Home", { step: { theme: "dark", background: "#f00" } }), [[100, 2]]);
    expect(seen.at[0]).toEqual([255, 0, 0, 255]);
    // white ink on red lifts the green or blue channel
    expect(seen.box(0, 199, 0, 23).some((p) => p[1]! > 100 || p[2]! > 100)).toBe(true);
  });

  it("lets the shot's color beat the step's", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, { text: "0.0 Home", color: "#0f0" }, { step: { color: "#f00" } }));
    const strip = seen.box(0, 199, 0, 23);
    // green ink on white never has less green than red; red ink always does
    expect(strip.every((p) => p[1]! >= p[0]!)).toBe(true);
    expect(strip.some((p) => p[1]! > p[0]!)).toBe(true);
  });

  it("centers a short label", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "0.0 Home"));
    const bare = (x0: number, x1: number) => seen.box(x0, x1, 0, 23).every((p) => p.join() === "255,255,255,255");
    expect(seen.inked).toBe(true);
    expect(bare(0, 39)).toBe(true);
    expect(bare(160, 199)).toBe(true);
  });

  it.each([200, 5000])("cuts a label of %i characters at the end, not the start", async (count) => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "W".repeat(count)));
    const bare = (x0: number, x1: number) => seen.box(x0, x1, 0, 23).every((p) => p.join() === "255,255,255,255");
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(bare(0, 7)).toBe(true);
    expect(bare(8, 40)).toBe(false);
    expect(bare(180, 199)).toBe(false);
  });

  it.each([
    [0, "scale must be a positive number, got 0"],
    [-1, "scale must be a positive number, got -1"],
    [NaN, "scale must be a positive number, got NaN"],
    [Infinity, "scale must be a positive number, got Infinity"],
    [0.01, "scale 0.01 makes a strip under 1 px"], // the strip rounds to 0 px
  ])("rejects a scale of %s", async (value, message) => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const before = readFileSync(path);
    await expect(run(path, "0.0 Home", { step: { scale: () => value } })).rejects.toThrow(`@snapseq/label: ${message}`);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(dir, "labelled"))).toEqual([]);
  });

  it("scales the strip with the device scale factor when scale is true", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    const seen = await look(await run(path, "0.0 Home", { step: { scale: true }, dsf: 2 }));
    expect([seen.width, seen.height]).toEqual([400, 248]);
    expect(seen.box(0, 399, 24, 47).some((p) => p.join() !== "255,255,255,255")).toBe(true);
  });

  it("maps the device scale factor with a scale function", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    const seen = await look(await run(path, "0.0 Home", { step: { scale: (d) => d / 2 }, dsf: 4 }));
    expect([seen.width, seen.height]).toEqual([400, 248]);
  });
});
