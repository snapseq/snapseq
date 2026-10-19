import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import sharp from "sharp";
import type { CaptureContext, Shot } from "snapseq";
import { afterEach, describe, expect, it } from "vitest";
import { pdf } from "../index.js";

let tmp = "";

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function setup() {
  tmp = mkdtempSync(join(tmpdir(), "snapseq-pdf-"));
  const dir = join(tmp, "run", "home", "desktop");
  mkdirSync(dir, { recursive: true });
  return { dir, ctx: { seq: { dir } } as unknown as CaptureContext };
}

async function makeShot(dir: string, index: number, width: number, height: number, jpeg = false, deviceScaleFactor = 1): Promise<Shot> {
  const name = `0${index}.${jpeg ? "jpg" : "png"}`;
  const path = join(dir, name);
  const image = sharp({ create: { width, height, channels: jpeg ? 3 : 4, background: "#cde" } });
  await (jpeg ? image.jpeg() : image.png()).toFile(path);
  return { name, path, url: "about:blank", index, options: {}, notes: [], format: jpeg ? { type: "jpeg" } : {}, deviceScaleFactor };
}

async function pageSizes(file: string) {
  const doc = await PDFDocument.load(await readFile(file));
  return doc.getPages().map((p) => [p.getWidth(), p.getHeight()]);
}

describe("pdf", () => {
  // build() calls img.embed() right after each page is drawn; the pages must come out whole.
  it("writes one page per shot at the shot's own size", async () => {
    const { dir, ctx } = setup();
    const shots = [
      await makeShot(dir, 1, 400, 300),
      await makeShot(dir, 2, 400, 900),
      await makeShot(dir, 3, 300, 250),
    ];

    await pdf().done!(shots, ctx);

    expect(await pageSizes(join(dir, "..", "desktop.pdf"))).toEqual([
      [300, 225],
      [300, 675],
      [225, 187.5],
    ]);
  });

  it("sizes a page by the shot's CSS size, so a 2x phone shot gives a phone-sized page", async () => {
    const { dir, ctx } = setup();
    const shots = [await makeShot(dir, 1, 780, 1688, false, 2), await makeShot(dir, 2, 400, 300)];

    await pdf().done!(shots, ctx);

    expect(await pageSizes(join(dir, "..", "desktop.pdf"))).toEqual([
      [292.5, 633],
      [300, 225],
    ]);
  });

  it("embeds JPEG shots", async () => {
    const { dir, ctx } = setup();
    const shots = [await makeShot(dir, 1, 400, 300, true), await makeShot(dir, 2, 200, 800, true)];

    await pdf().done!(shots, ctx);

    expect(await pageSizes(join(dir, "..", "desktop.pdf"))).toEqual([
      [300, 225],
      [150, 600],
    ]);
  });

  it("removes the previous run's PDF when a capture begins", async () => {
    const { dir, ctx } = setup();
    const file = join(dir, "..", "desktop.pdf");
    writeFileSync(file, "stale");
    await pdf().begin!(ctx);
    expect(existsSync(file)).toBe(false);
  });

  it("scales a page whose longer side would pass 14400 pt, keeping the aspect ratio", async () => {
    const { dir, ctx } = setup();
    const shots = [await makeShot(dir, 1, 100, 40000), await makeShot(dir, 2, 400, 300)];

    await pdf().done!(shots, ctx);

    expect(await pageSizes(join(dir, "..", "desktop.pdf"))).toEqual([
      [36, 14400],
      [300, 225],
    ]);
  });

  // img.embed() writes each image into the document and drops its decoded copy, so
  // memory peaks at a few images, not at all of them. Decoded data lives in ArrayBuffers,
  // not on the JS heap, so this samples arrayBuffers; heapUsed does not move.
  it("holds a few decoded images at a time, not every one until save", async () => {
    const { dir, ctx } = setup();
    const [n, w, h] = [10, 1000, 6000];
    const shots: Shot[] = [];
    for (let i = 1; i <= n; i++) shots.push(await makeShot(dir, i, w, h));
    const base = process.memoryUsage().arrayBuffers;
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 1);

    await pdf().done!(shots, ctx);
    clearInterval(timer);

    // Without embed() the peak is every decoded image (n * w * h * 4 bytes); with it, 2 or 3.
    expect(peak - base).toBeLessThan((n * w * h * 4) / 2);
    expect((await pageSizes(join(dir, "..", "desktop.pdf"))).length).toBe(n);
  });

  it("removes a stale partial PDF when a capture begins", async () => {
    const { dir, ctx } = setup();
    const file = join(dir, "..", "desktop.partial.pdf");
    writeFileSync(file, "stale");
    await pdf().begin!(ctx);
    expect(existsSync(file)).toBe(false);
  });

  it("writes the shots so far to <device>.partial.pdf when a capture fails", async () => {
    const { dir, ctx } = setup();
    const shots = [await makeShot(dir, 1, 400, 300), await makeShot(dir, 2, 400, 900)];

    await pdf().failed!(shots, ctx);

    expect(await pageSizes(join(dir, "..", "desktop.partial.pdf"))).toEqual([
      [300, 225],
      [300, 675],
    ]);
    expect(existsSync(join(dir, "..", "desktop.pdf"))).toBe(false);
  });

  it("writes no partial PDF when a capture fails before its first shot", async () => {
    const { dir, ctx } = setup();
    await pdf().failed!([], ctx);
    expect(existsSync(join(dir, "..", "desktop.partial.pdf"))).toBe(false);
  });

  it("writes nothing for an empty capture", async () => {
    const { dir, ctx } = setup();
    await pdf().done!([], ctx);
    expect(existsSync(join(dir, "..", "desktop.pdf"))).toBe(false);
  });
});
