import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureContext } from "../fixtures.js";
import type { Plugin } from "../plugin.js";
import { createSequence, type SnapOptions } from "../sequence.js";

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
      if (src.includes("devicePixelRatio")) return 2;
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

  it("numbers screenshots 01, 02, … as PNGs", async () => {
    const { page, calls } = makePageStub();
    const seq = createSequence(page, root, join("cap", "desktop"));
    await seq.snap();
    await seq.snapPage();
    await seq.snap({ fullPage: true });
    expect(calls.map((c) => c.path)).toEqual([
      join(seq.dir, "01.png"),
      join(seq.dir, "02.png"),
      join(seq.dir, "03.png"),
    ]);
    // snapPage shoots the viewport, which it has grown to the document; native full page is opt-in.
    expect(calls.map((c) => c.fullPage)).toEqual([false, false, true]);
    expect(page.screenshot.mock.calls[0]?.[0]).toEqual({ path: join(seq.dir, "01.png") }); // png by its extension
    expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe(
      "01.png  http://x/p\n02.png  http://x/p\n03.png  http://x/p\n",
    );
  });

  it("pads shot numbers to the numbering's width", async () => {
    const two = createSequence(makePageStub().page, root, join("two", "d"), { numbering: "00" });
    const four = createSequence(makePageStub().page, root, join("four", "d"), { numbering: "0000" });
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

  it("writes .jpg files when the format is jpeg, passing its type and quality through", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap", { format: { type: "jpeg", quality: 60 } });
    await seq.snap();
    await seq.snapPage({ omitBackground: true });
    expect(readdirSync(seq.dir).sort()).toEqual(["01.jpg", "02.jpg", "shots.txt"]);
    expect(page.screenshot.mock.calls[1]?.[0]).toEqual({
      path: join(seq.dir, "02.jpg"),
      type: "jpeg",
      quality: 60,
      omitBackground: true,
    });
    expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe("01.jpg  http://x/p\n02.jpg  http://x/p\n");
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
    writeFileSync(join(sibling, "01.png"), "keep");

    createSequence(makePageStub().page, root, join("cap", "desktop"));

    expect(readdirSync(mine)).toEqual([]);
    expect(existsSync(join(sibling, "01.png"))).toBe(true);
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
      "01.png  http://x/p\n02.png  http://x/p  DOM still changing after 3 s, 2 images still loading after 5 s\n",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "snapseq: 02.png taken with  DOM still changing after 3 s, 2 images still loading after 5 s  http://x/p",
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

  describe("plugins", () => {
    const ctx = { device: "d1" } as CaptureContext;

    it("passes what a beforeSnap hook put in the options to the screenshot, but never its path or type", async () => {
      const { page } = makePageStub();
      const plugins: Plugin[] = [
        {
          name: "mask",
          beforeSnap: async (shot) => {
            const options = shot.options as Record<string, unknown>;
            options.mask = ["x"];
            options.path = "evil";
            options.type = "jpeg";
          },
        },
      ];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snap({ label: "Hero" } as SnapOptions);
      const call = page.screenshot.mock.calls[0]?.[0];
      expect(call).toEqual({ label: "Hero", mask: ["x"], path: join(seq.dir, "01.png") });
      expect(call.type).toBeUndefined(); // the config's: unset, so PNG
      expect(seq.shots[0]?.options).toEqual({ label: "Hero", mask: ["x"], path: "evil", type: "jpeg" });
    });

    it("runs beforeSnap hooks first: before the readiness waits, and before snapPage reads and grows the viewport", async () => {
      const { page } = makePageStub();
      const events: string[] = [];
      const evaluate = page.evaluate.getMockImplementation();
      page.evaluate.mockImplementation(async (fn: unknown) => (events.push("evaluate"), evaluate(fn)));
      const viewportSize = page.viewportSize;
      page.viewportSize = () => (events.push("viewportSize"), viewportSize());
      const setViewportSize = page.setViewportSize.getMockImplementation();
      page.setViewportSize.mockImplementation(async (size: unknown) => (events.push("setViewportSize"), setViewportSize(size)));
      const plugins: Plugin[] = [{ name: "a", beforeSnap: async (shot) => void events.push(`beforeSnap written=${existsSync(shot.path)}`) }];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snapPage();
      // The first evaluate is the device scale factor, read once per sequence.
      expect(events.slice(0, 5)).toEqual(["evaluate", "beforeSnap written=false", "viewportSize", "evaluate", "setViewportSize"]);
      events.length = 0;
      await seq.snap();
      expect(events.slice(0, 2)).toEqual(["beforeSnap written=false", "evaluate"]);
    });

    it("keeps a fullPage that a beforeSnap hook set off a snapPage screenshot; snap passes it on", async () => {
      const { page, calls } = makePageStub();
      const seen: unknown[] = [];
      const plugins: Plugin[] = [
        {
          name: "full",
          beforeSnap: async (shot) => void (shot.options.fullPage = true),
          afterSnap: async (shot) => void seen.push(shot.options.fullPage),
        },
      ];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snapPage();
      await seq.snap();
      expect(calls.map((c) => c.fullPage)).toEqual([false, true]);
      expect("fullPage" in page.screenshot.mock.calls[0]?.[0]).toBe(false);
      expect(seen).toEqual([undefined, true]); // dropped from the snapPage shot, kept on snap's
    });

    it("titles and lists a shot with the URL at screenshot time, after a beforeSnap hook navigated", async () => {
      const { page } = makePageStub();
      const titles: string[] = [];
      const seen: string[] = [];
      const seq = createSequence(page, root, "cap", {
        wrap: (title, shoot) => (titles.push(title), shoot()),
        plugins: [{ name: "nav", beforeSnap: async (shot) => { seen.push(shot.url); page.url = () => "http://x/later"; } }],
        ctx,
      });
      await seq.snap();
      expect(seen).toEqual(["http://x/p"]);
      expect(titles).toEqual(["01.png  http://x/later"]);
      expect(seq.shots[0]?.url).toBe("http://x/later");
      expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe("01.png  http://x/later\n");
    });

    it("hands beforeSnap no notes and afterSnap the readiness notes", async () => {
      const { page } = makePageStub();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      page.evaluate.mockImplementation(async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("scrollHeight")) return 900;
        if (src.includes("document.images")) return 0;
        return !src.includes("MutationObserver"); // the DOM never went quiet
      });
      const seen: string[][] = [];
      const plugins: Plugin[] = [
        {
          name: "n",
          beforeSnap: async (shot) => void seen.push([...shot.notes]),
          afterSnap: async (shot) => void seen.push([...shot.notes]),
        },
      ];
      await createSequence(page, root, "cap", { plugins, ctx }).snap();
      expect(seen).toEqual([[], ["DOM still changing after 3 s"]]);
    });

    it("fails the shot when a beforeSnap hook throws, naming the plugin and the file, before any screenshot; the number is given back", async () => {
      const { page } = makePageStub();
      const kaput = new Error("kaput");
      let thrown = false;
      const seq = createSequence(page, root, "cap", {
        plugins: [{ name: "boom", beforeSnap: async () => { if (!thrown) { thrown = true; throw kaput; } } }],
        ctx,
      });
      await expect(seq.snap()).rejects.toMatchObject({
        message: 'snapseq: plugin "boom" threw in beforeSnap on 01.png: kaput',
        cause: kaput,
      });
      expect(page.screenshot).not.toHaveBeenCalled();
      await seq.snap();
      expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe("01.png  http://x/p\n");
    });

    it("runs afterSnap hooks in listing order, after the file is written and before its shots.txt line", async () => {
      const { page } = makePageStub();
      const events: string[] = [];
      const listed = () => (existsSync(join(seq.dir, "shots.txt")) ? readFileSync(join(seq.dir, "shots.txt"), "utf8") : "");
      const plugins: Plugin[] = [
        {
          name: "a",
          afterSnap: async (shot, c) => {
            await new Promise((r) => setTimeout(r, 10)); // b must wait for this
            events.push(`a ${shot.name} written=${existsSync(shot.path)} ctx=${c === ctx} listed=${JSON.stringify(listed())}`);
          },
        },
        { name: "b", afterSnap: async (shot) => void events.push(`b ${shot.name}`) },
      ];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snap();
      await seq.snapPage();
      expect(events).toEqual([
        'a 01.png written=true ctx=true listed=""',
        "b 01.png",
        'a 02.png written=true ctx=true listed="01.png  http://x/p\\n"',
        "b 02.png",
      ]);
      expect(listed()).toBe("01.png  http://x/p\n02.png  http://x/p\n");
    });

    it("fails the shot when an afterSnap hook throws, naming the plugin and the file, and does not list it", async () => {
      const { page } = makePageStub();
      const kaput = new Error("kaput");
      const seq = createSequence(page, root, "cap", {
        plugins: [{ name: "boom", afterSnap: async () => { throw kaput; } }],
        ctx,
      });
      await expect(seq.snap()).rejects.toThrow(new Error('snapseq: plugin "boom" threw in afterSnap on 01.png: kaput'));
      await expect(seq.snap()).rejects.toMatchObject({ cause: kaput });
      expect(existsSync(join(seq.dir, "01.png"))).toBe(true);
      expect(existsSync(join(seq.dir, "shots.txt"))).toBe(false);
      expect(seq.shots).toEqual([]);
    });

    it("lists every shot with its name, path, url, index, options, notes and format", async () => {
      const { page } = makePageStub();
      const format = { type: "jpeg", quality: 60 } as const;
      const seq = createSequence(page, root, "cap", { format });
      await seq.snap({ omitBackground: true });
      await seq.snapPage();
      const shot = (n: number, options: SnapOptions) => ({
        name: `0${n}.jpg`,
        path: join(seq.dir, `0${n}.jpg`),
        url: "http://x/p",
        index: n,
        options,
        notes: [],
        format,
        deviceScaleFactor: 2,
      });
      expect(seq.shots).toEqual([shot(1, { omitBackground: true }), shot(2, {})]);
    });
  });

  it("takes one shot at a time: a second snap before the first resolved throws", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    const first = seq.snap();
    await expect(seq.snap()).rejects.toThrow("a shot is already in progress");
    await first;
    await seq.snap();
    expect(seq.shots.map((s) => s.name)).toEqual(["01.png", "02.png"]);
  });

  it("does not list a shot whose hook resolved after the capture ended", async () => {
    const { page } = makePageStub();
    const ended = new AbortController();
    let release!: () => void;
    const seq = createSequence(page, root, "cap", {
      signal: ended.signal,
      plugins: [{ name: "slow", afterSnap: () => new Promise<void>((r) => (release = r)) }],
    });
    const late = seq.snap();
    await new Promise((r) => setTimeout(r, 20)); // the hook is pending
    ended.abort();
    release();
    await expect(late).rejects.toThrow("the capture ended before 01.png was listed");
    expect(seq.shots).toHaveLength(0);
    expect(existsSync(join(seq.dir, "shots.txt"))).toBe(false);
  });

  it("hands a hook its own copy of format and notes", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap", {
      plugins: [{ name: "mut", afterSnap: async (shot) => { shot.format.type = "jpeg"; shot.notes.push("x\ninjected"); } }],
    });
    await seq.snap();
    await seq.snap();
    expect(readdirSync(seq.dir).sort()).toEqual(["01.png", "02.png", "shots.txt"]);
    expect(readFileSync(join(seq.dir, "shots.txt"), "utf8")).toBe("01.png  http://x/p\n02.png  http://x/p\n");
  });

  it("reads the device scale factor once per sequence and hands it to every shot, beforeSnap included", async () => {
    const { page } = makePageStub();
    const seen: number[] = [];
    const plugins: Plugin[] = [{ name: "d", beforeSnap: async (shot) => void seen.push(shot.deviceScaleFactor) }];
    const seq = createSequence(page, root, "cap", { plugins, ctx: { device: "d1" } as CaptureContext });
    await seq.snap();
    await seq.snapPage();
    expect(seen).toEqual([2, 2]);
    expect(seq.shots.map((s) => s.deviceScaleFactor)).toEqual([2, 2]);
    expect(page.evaluate.mock.calls.filter((c: unknown[]) => String(c[0]).includes("devicePixelRatio"))).toHaveLength(1);
  });
});
