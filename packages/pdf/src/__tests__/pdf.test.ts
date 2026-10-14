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

  it("writes nothing for an empty capture", async () => {
    const { dir, ctx } = setup();
    await pdf().done!([], ctx);
    expect(existsSync(join(dir, "..", "desktop.pdf"))).toBe(false);
  });
});
