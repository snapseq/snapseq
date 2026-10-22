import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import type { Capture, ShotFormat, SnapOptions } from "snapseq";
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

// A capture of the given files, as the orchestration would hold it.
function capture(dir: string, files: { path: string; label?: SnapOptions["label"]; format?: ShotFormat; dsf?: number }[]): Capture {
  return {
    sequence: "12345-spring-launch",
    device: "desktop",
    env: "uat",
    host: "https://uat.example.com",
    dir,
    reused: false,
    shots: files.map(({ path, label, format = {}, dsf = 1 }, i) => ({
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
  { step = {}, format = {}, dsf = 1 }: { step?: LabelOptions; format?: ShotFormat; dsf?: number } = {},
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

  it("copies a shot without a label byte for byte", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const file = await run(path, undefined);
    expect(file).toBe(join(dir, "labelled", "01.png"));
    expect(readFileSync(file).equals(readFileSync(path))).toBe(true);
  });

  it("copies a shot whose label text is empty", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    expect(readFileSync(await run(path, "")).equals(readFileSync(path))).toBe(true);
    expect(readFileSync(await run(path, { text: "", theme: "dark" })).equals(readFileSync(path))).toBe(true);
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

  it("returns an empty array and writes nothing for no captures", async () => {
    const dir = tmp();
    expect(await label([])).toEqual([]);
    expect(await label([], { theme: "dark" })).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes over a file that is already in labelled/", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    mkdirSync(join(dir, "labelled"));
    writeFileSync(join(dir, "labelled", "01.png"), "stale");
    const seen = await look(await run(path, "0.0 Home"));
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  it("keeps a 2x shot at its pixels", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png", 400, 200);
    const seen = await look(await run(path, "2x", { dsf: 2 }));
    expect([seen.width, seen.height]).toEqual([400, 224]);
  });

  it("writes a JPEG when the format is jpeg", async () => {
    const dir = tmp();
    const path = await source(dir, "01.jpg", 200, 100, "jpeg");
    const file = await run(path, "jpeg", { format: { type: "jpeg", quality: 50 } });
    expect([...readFileSync(file).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const seen = await look(file);
    expect([seen.width, seen.height]).toEqual([200, 124]);
  });

  it("draws a label with control characters and lone surrogates as spaces", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "a\vb\x1bc\ufffed\ud800e"));
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.inked).toBe(true);
  });

  it("renders the label as text, not markup", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "<b>&"));
    expect([seen.width, seen.height]).toEqual([200, 124]);
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
    expect([seen.width, seen.height]).toEqual([200, 124]);
    expect(seen.at[0]).toEqual([255, 255, 255, 255]);
    expect(seen.at[1]).toEqual([255, 0, 0, 255]);
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

  it("centers a short label", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "0.0 Home"));
    expect(seen.box(0, 39, 0, 23).every((p) => p.join() === "255,255,255,255")).toBe(true);
  });

  it("cuts a long label at the end, not the start", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "W".repeat(200)));
    const bare = (x0: number, x1: number) => seen.box(x0, x1, 0, 23).every((p) => p.join() === "255,255,255,255");
    expect(bare(0, 7)).toBe(true);
    expect(bare(8, 40)).toBe(false);
    expect(bare(180, 199)).toBe(false);
  });

  it("cuts a label of thousands of characters at the end, not the start", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const seen = await look(await run(path, "W".repeat(5000)));
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
    await expect(run(path, "0.0 Home", { step: { scale: () => value } })).rejects.toThrow(
      `@snapseq/label: scale must be a positive number, got ${value}`,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(dir, "labelled"))).toEqual([]);
  });

  it("does not look at scale for a shot without a label", async () => {
    const dir = tmp();
    const path = await source(dir, "01.png");
    const file = await run(path, undefined, { step: { scale: () => 0 } });
    expect(readFileSync(file).equals(readFileSync(path))).toBe(true);
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
