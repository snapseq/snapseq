import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import sharp from "sharp";
import type { Capture, CaptureShot } from "snapseq";
import { afterEach, describe, expect, it } from "vitest";
import { pdf } from "../index.js";

let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "snapseq-pdf-"));
  return tmp;
}

async function makeShot(dir: string, index: number, width: number, height: number, jpeg = false, deviceScaleFactor = 1): Promise<CaptureShot> {
  mkdirSync(dir, { recursive: true });
  const name = `0${index}.${jpeg ? "jpg" : "png"}`;
  const path = join(dir, name);
  const image = sharp({ create: { width, height, channels: jpeg ? 3 : 4, background: "#cde" } });
  await (jpeg ? image.jpeg() : image.png()).toFile(path);
  return { index, name, path, url: "about:blank", notes: [], deviceScaleFactor, format: { type: jpeg ? "jpeg" : "png" }, options: {} };
}

function capture(dir: string, sequence: string, shots: CaptureShot[], device = "desktop"): Capture {
  return { sequence, device, env: "uat", host: "https://example.test", dir, reused: false, shots };
}

async function pageSizes(file: string) {
  const doc = await PDFDocument.load(await readFile(file));
  return doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
}

describe("pdf", () => {
  // The page is read back from the PDF, so the pages must come out whole after embed().
  it("writes one page per shot across captures, in capture order, and returns the file", async () => {
    const root = setup();
    const a = join(root, "a", "desktop");
    const b = join(root, "b", "desktop");
    const first = capture(a, "a", [await makeShot(a, 1, 400, 300), await makeShot(a, 2, 400, 900)]);
    const second = capture(b, "b", [await makeShot(b, 1, 300, 250), await makeShot(b, 2, 800, 200), await makeShot(b, 3, 100, 100)]);
    const file = join(root, "out.pdf");

    expect(await pdf([first, second], file)).toBe(file);
    const sizes = [
      [300, 225],
      [300, 675],
      [225, 187.5],
      [600, 150],
      [75, 75],
    ];
    expect(await pageSizes(file)).toEqual(sizes);

    // Reversing the captures reverses the groups, not the shots inside them.
    const reversed = join(root, "reversed.pdf");
    await pdf([second, first], reversed);
    expect(await pageSizes(reversed)).toEqual([...sizes.slice(2), ...sizes.slice(0, 2)]);
  });

  it("puts the shots of a capture in index order", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const one = await makeShot(dir, 1, 400, 300);
    const two = await makeShot(dir, 2, 400, 900);
    const file = join(root, "out.pdf");

    await pdf([capture(dir, "a", [two, one])], file);

    expect(await pageSizes(file)).toEqual([
      [300, 225],
      [300, 675],
    ]);
  });

  it("sizes a page by pixels divided by deviceScaleFactor, so a 2x phone shot gives a phone-sized page", async () => {
    const root = setup();
    const dir = join(root, "a", "mobile");
    const file = join(root, "out.pdf");

    await pdf([capture(dir, "a", [await makeShot(dir, 1, 780, 1688, false, 2), await makeShot(dir, 2, 400, 300)], "mobile")], file);

    expect(await pageSizes(file)).toEqual([
      [292.5, 633],
      [300, 225],
    ]);
  });

  it("embeds JPEG shots next to PNG ones", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out.pdf");
    const jpegShot = await makeShot(dir, 1, 400, 300, true);
    const pngShot = await makeShot(dir, 2, 200, 800);

    await pdf([capture(dir, "a", [jpegShot, pngShot])], file);

    expect(await pageSizes(file)).toEqual([
      [300, 225],
      [150, 600],
    ]);
  });

  it("scales a page whose longer side would pass 14400 pt, keeping the aspect ratio", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out.pdf");

    await pdf([capture(dir, "a", [await makeShot(dir, 1, 100, 40000), await makeShot(dir, 2, 400, 300)])], file);

    expect(await pageSizes(file)).toEqual([
      [36, 14400],
      [300, 225],
    ]);
  });

  it("throws, and writes nothing, for an empty list or captures without shots", async () => {
    const root = setup();
    const file = join(root, "out", "desktop.pdf");

    await expect(pdf([], file)).rejects.toThrow("@snapseq/pdf: nothing to bind");
    await expect(pdf([capture(join(root, "a"), "a", []), capture(join(root, "b"), "b", [])], file)).rejects.toThrow("@snapseq/pdf: nothing to bind");
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("keeps an existing file when a shot cannot be read, and leaves no temporary file", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out", "desktop.pdf");
    mkdirSync(join(root, "out"));
    writeFileSync(file, "previous");
    const shot = await makeShot(dir, 1, 400, 300);

    await expect(pdf([capture(dir, "a", [{ ...shot, path: join(dir, "missing.png") }])], file)).rejects.toThrow(/ENOENT/);

    expect(await readFile(file, "utf8")).toBe("previous");
    expect(await readdir(join(root, "out"))).toEqual(["desktop.pdf"]);
  });

  // A file system that ignores case (macOS, Windows): 01.PNG names the shot 01.png.
  const caseless = (() => {
    const probe = mkdtempSync(join(tmpdir(), "pdf-case-"));
    try {
      return existsSync(probe.toUpperCase()) && existsSync(probe.toLowerCase());
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  })();
  it.skipIf(!caseless)("refuses a file that names a shot in another case", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const shot = await makeShot(dir, 1, 400, 300);
    const before = await readFile(shot.path);
    await expect(pdf([capture(dir, "a", [shot])], join(dir, shot.name.toUpperCase()))).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    expect((await readFile(shot.path)).equals(before)).toBe(true);
  });

  it("refuses a shot's own path when that path is a link: the rename would put the PDF where the shot is recorded", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const real = await makeShot(dir, 1, 400, 300);
    const linked = { ...real, path: join(root, "linked.png") };
    symlinkSync(real.path, linked.path);
    await expect(pdf([capture(dir, "a", [linked])], linked.path)).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    // the same link through another spelling of its folder
    symlinkSync(root, join(root, "..", `${basename(root)}-alias`));
    const alias = join(root, "..", `${basename(root)}-alias`, "linked.png");
    await expect(pdf([capture(dir, "a", [linked])], alias)).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    rmSync(join(root, "..", `${basename(root)}-alias`));
  });

  it("writes through a link at the file's own name: rename() replaces the link, not the shot", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const shot = await makeShot(dir, 1, 400, 300);
    const before = await readFile(shot.path);
    symlinkSync(shot.path, join(root, "link.pdf"));
    await pdf([capture(dir, "a", [shot])], join(root, "link.pdf"));
    expect((await readFile(shot.path)).equals(before)).toBe(true);
  });

  it("refuses a file that is one of the shots, and leaves the shot alone", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const shot = await makeShot(dir, 1, 400, 300);
    const before = await readFile(shot.path);

    await expect(pdf([capture(dir, "a", [shot])], shot.path)).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    // the same path spelled another way is the same file
    await expect(pdf([capture(dir, "a", [shot])], join(dir, "..", "desktop", shot.name))).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    // and through a linked folder: rename() writes where the link points
    symlinkSync(dir, join(root, "delivery"));
    await expect(pdf([capture(dir, "a", [shot])], join(root, "delivery", shot.name))).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    // a ".." after a link is taken from where the link points, not from the path as written
    mkdirSync(join(dir, "sub"));
    symlinkSync(join(dir, "sub"), join(root, "into-sub"));
    await expect(pdf([capture(dir, "a", [shot])], `${root}/into-sub/../${shot.name}`)).rejects.toThrow("@snapseq/pdf: file is one of the shots");
    rmSync(join(dir, "sub"), { recursive: true });

    expect((await readFile(shot.path)).equals(before)).toBe(true);
    expect(await readdir(dir)).toEqual([shot.name]);
  });

  it("lets two calls on one file both finish, and leaves a valid PDF and no temporary file", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out", "run", "desktop.pdf"); // two missing levels: the parent is created recursively
    const caps = [capture(dir, "a", [await makeShot(dir, 1, 400, 300), await makeShot(dir, 2, 400, 900)])];

    expect(await Promise.all([pdf(caps, file), pdf(caps, file)])).toEqual([file, file]);

    expect(await pageSizes(file)).toEqual([
      [300, 225],
      [300, 675],
    ]);
    expect(await readdir(join(root, "out", "run"))).toEqual(["desktop.pdf"]);
  });

  it.each([0, -1, NaN, Infinity])("rejects a deviceScaleFactor of %s, and writes nothing", async (value) => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out", "desktop.pdf");
    const shot = await makeShot(dir, 1, 400, 300, false, value);

    await expect(pdf([capture(dir, "a", [shot])], file)).rejects.toThrow(
      `@snapseq/pdf: deviceScaleFactor must be a positive number, got ${value}`,
    );
    expect(existsSync(join(root, "out"))).toBe(false);
  });

  it("leaves no temporary file when the file is a directory", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out.pdf");
    mkdirSync(file);

    await expect(pdf([capture(dir, "a", [await makeShot(dir, 1, 400, 300)])], file)).rejects.toThrow(/EISDIR/);

    expect((await readdir(root)).sort()).toEqual(["a", "out.pdf"]);
  });

  // img.embed() writes each image into the document and drops its decoded copy, so
  // memory peaks at a few images, not at all of them. Decoded data lives in ArrayBuffers,
  // not on the JS heap, so this samples arrayBuffers; heapUsed does not move.
  it("holds a few decoded images at a time, not every one until save", async () => {
    const root = setup();
    const dir = join(root, "a", "desktop");
    const file = join(root, "out.pdf");
    const [n, w, h] = [10, 1000, 6000];
    const shots: CaptureShot[] = [];
    for (let i = 1; i <= n; i++) shots.push(await makeShot(dir, i, w, h));
    const base = process.memoryUsage().arrayBuffers;
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 1);

    await pdf([capture(dir, "a", shots)], file);
    clearInterval(timer);

    // Without embed() the peak is every decoded image (n * w * h * 4 bytes); with it, 2 or 3.
    expect(peak - base).toBeLessThan((n * w * h * 4) / 2);
    expect((await pageSizes(file)).length).toBe(n);
  });
});
