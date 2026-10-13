import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSequence } from "../sequence.js";

function makePageStub(documentHeight = 900) {
  const calls: Array<{ path: string; fullPage: boolean }> = [];
  const viewports: Array<{ width: number; height: number }> = [];
  let viewport = { width: 400, height: 300 };
  const page = {
    screenshot: vi.fn(async (opts: { path: string; fullPage?: boolean }) => {
      writeFileSync(opts.path, "png-stub");
      calls.push({ path: opts.path, fullPage: !!opts.fullPage });
    }),
    viewportSize: () => viewport,
    url: () => "http://x/p",
    setViewportSize: vi.fn(async (size: { width: number; height: number }) => {
      viewport = size;
      viewports.push(size);
    }),
    // Serves the height measurement, the quiet, font and image waits, by what each asks.
    evaluate: vi.fn(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("scrollHeight")) return documentHeight;
      if (src.includes("document.images")) return 0; // none pending
      return true; // quiet in time, fonts in
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { page: page as any, calls, viewports };
}

describe("createSequence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "snapseq-seq-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("numbers screenshots 001, 002, …", async () => {
    const { page, calls } = makePageStub();
    const seq = createSequence(page, root, join("cap", "desktop"));
    await seq.snap();
    await seq.snapPage();
    await seq.snap({ fullPage: true });
    expect(calls.map((c) => c.path)).toEqual([
      join(seq.dir, "001.png"),
      join(seq.dir, "002.png"),
      join(seq.dir, "003.png"),
    ]);
    // snapPage shoots the viewport, which it has grown to the document; native full page is opt-in.
    expect(calls.map((c) => c.fullPage)).toEqual([false, false, true]);
    expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe(
      "001.png  http://x/p\n002.png  http://x/p\n003.png  http://x/p\n",
    );
  });

  it("pads shot numbers to the numbering's width", async () => {
    const two = createSequence(makePageStub().page, root, join("two", "d"), undefined, "00");
    const four = createSequence(makePageStub().page, root, join("four", "d"), undefined, "0000");
    for (let i = 0; i < 10; i++) await two.snap();
    await four.snap();
    expect(readdirSync(two.dir).sort()).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `0${i + 1}.png`),
      "10.png",
      "shots.txt",
    ]);
    expect(readdirSync(four.dir).sort()).toEqual(["0001.png", "shots.txt"]);
    expect(readFileSync(join(four.dir, "shots.txt"), "utf8")).toBe("0001.png  http://x/p\n");
  });

  it("snapPage grows the viewport to the document height and restores it, also when the shot fails", async () => {
    const { page, viewports } = makePageStub(900);
    const seq = createSequence(page, root, join("cap", "desktop"));
    await seq.snapPage();
    expect(viewports).toEqual([
      { width: 400, height: 900 },
      { width: 400, height: 300 },
    ]);

    page.screenshot.mockRejectedValueOnce(new Error("boom"));
    await expect(seq.snapPage()).rejects.toThrow("boom");
    expect(viewports.at(-1)).toEqual({ width: 400, height: 300 });
  });

  it("wipes only its own directory on creation", () => {
    const mine = join(root, "cap", "desktop");
    const sibling = join(root, "cap", "mobile");
    mkdirSync(mine, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(mine, "999.png"), "stale");
    writeFileSync(join(sibling, "001.png"), "keep");

    createSequence(makePageStub().page, root, join("cap", "desktop"));

    expect(readdirSync(mine)).toEqual([]);
    expect(existsSync(join(sibling, "001.png"))).toBe(true);
  });

  it("refuses to wipe a directory outside its root, the root itself included", () => {
    const outside = join(root, "outside", "cap", "desktop");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const out = join(root, "out");
    const { page } = makePageStub();
    expect(() => createSequence(page, out, join("..", "outside", "cap", "desktop"))).toThrow("not inside");
    expect(() => createSequence(page, out, "")).toThrow("not inside");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("records a readiness cap on the shot's line and warns, and says nothing otherwise", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seq.snap();
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("scrollHeight")) return 900;
      if (src.includes("document.images")) return 2; // two still pending at the cap
      return !src.includes("MutationObserver"); // the DOM never went quiet
    });
    await seq.snap();
    expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe(
      "001.png  http://x/p\n002.png  http://x/p  DOM still changing after 3 s, 2 images still loading after 5 s\n",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "snapseq: 002.png taken with  DOM still changing after 3 s, 2 images still loading after 5 s  http://x/p",
    );
  });

  it("snapPage refuses a page whose height follows the viewport, and restores the viewport", async () => {
    const { page, viewports } = makePageStub();
    // Every measurement comes back taller than the viewport just set.
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("scrollHeight")) return page.viewportSize().height + 500;
      if (src.includes("document.images")) return 0;
      return true;
    });
    const seq = createSequence(page, root, "cap");
    await expect(seq.snapPage()).rejects.toThrow("snap({ fullPage: true })");
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(viewports.at(-1)).toEqual({ width: 400, height: 300 });
  });
});
