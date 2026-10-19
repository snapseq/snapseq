import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SequenceContext } from "../fixtures.js";
import type { Plugin } from "../plugin.js";
import { createSequence, type Sequence, type SnapOptions } from "../sequence.js";

// Each listed shot as one line: name, URL, then its notes.
const lines = (seq: Sequence) => seq.shots.map((s) => `${s.name}  ${s.url}${s.notes.length > 0 ? `  ${s.notes.join(", ")}` : ""}`);

// The page's window as the scroll save and restore see it: they run for real against it. A new one is a reload.
function makeWindow(timeOrigin: number, events: string[]) {
  return {
    performance: { timeOrigin },
    scrollX: 0,
    scrollY: 1500,
    scrollTo: vi.fn((to: { top: number }) => void events.push(`scrollTo ${to.top}`)),
  };
}

function makePageStub(documentHeight = 900, container = "", ratio: unknown = 2) {
  const calls: Array<{ path: string; fullPage: boolean }> = [];
  const viewports: Array<{ width: number; height: number }> = [];
  // What the page was asked, in order.
  const events: string[] = [];
  let viewport = { width: 400, height: 300 };
  vi.stubGlobal("window", makeWindow(1, events));
  const page = {
    screenshot: vi.fn(async (opts: { path: string; fullPage?: boolean }) => {
      writeFileSync(opts.path, "png-stub");
      calls.push({ path: opts.path, fullPage: !!opts.fullPage });
      events.push("screenshot");
    }),
    viewportSize: () => (events.push("viewportSize"), viewport),
    url: () => "http://x/p",
    waitForLoadState: vi.fn(async (state: string) => void events.push(`waitForLoadState ${state}`)),
    setViewportSize: vi.fn(async (size: { width: number; height: number }) => {
      viewport = size;
      viewports.push(size);
      events.push(`setViewportSize ${size.height}`);
    }),
    // Serves each evaluate by what it asks, and records which it was.
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
      const src = String(fn);
      const kind = src.includes("timeOrigin")
        ? "scroll"
        : src.includes("querySelectorAll")
          ? "container"
          : src.includes("documentElement.scrollHeight")
            ? "height"
            : src.includes("document.images")
              ? "images"
              : src.includes("devicePixelRatio")
                ? "ratio"
                : "wait";
      events.push(kind);
      if (kind === "scroll") return (fn as (a: unknown) => unknown)(arg); // against the stubbed window
      if (kind === "container") return container;
      if (kind === "height") return documentHeight;
      if (kind === "images") return { pending: 0, first: "", failed: 0, firstFailed: "" };
      if (kind === "ratio") return ratio;
      return true; // quiet in time, fonts in
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { page: page as any, calls, viewports, events };
}

describe("createSequence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "snapseq-seq-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    expect(lines(seq)).toEqual(["01.png  http://x/p", "02.png  http://x/p", "03.png  http://x/p"]);
  });

  it("pads shot numbers to the numbering's width", async () => {
    const two = createSequence(makePageStub().page, root, join("two", "d"), { numbering: "00" });
    const four = createSequence(makePageStub().page, root, join("four", "d"), { numbering: "0000" });
    for (let i = 0; i < 10; i++) await two.snap();
    await four.snap();
    expect(readdirSync(two.dir).sort()).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `0${i + 1}.png`),
      "10.png",
    ]);
    expect(readdirSync(four.dir)).toEqual(["0001.png"]);
    expect(lines(four)).toEqual(["0001.png  http://x/p"]);
  });

  it("writes .jpg files when the format is jpeg, passing its type and quality through", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap", { format: { type: "jpeg", quality: 60 } });
    await seq.snap();
    await seq.snapPage({ omitBackground: true });
    expect(readdirSync(seq.dir).sort()).toEqual(["01.jpg", "02.jpg"]);
    expect(page.screenshot.mock.calls[1]?.[0]).toEqual({
      path: join(seq.dir, "02.jpg"),
      type: "jpeg",
      quality: 60,
      omitBackground: true,
    });
    expect(lines(seq)).toEqual(["01.jpg  http://x/p", "02.jpg  http://x/p"]);
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

  it("records a readiness cap on the shot and warns, and says nothing otherwise", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seq.snap();
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("scrollHeight")) return 900;
      // Two still pending at the cap, one failed with no URL to name.
      if (src.includes("document.images")) return { pending: 2, first: "http://x/a.png", failed: 1, firstFailed: "" };
      return !src.includes("MutationObserver") && !src.includes("document.fonts"); // the DOM never went quiet, the fonts never settled
    });
    await seq.snap();
    // The notes stay on the shot; the terminal line reads as a sentence.
    expect(lines(seq)).toEqual([
      "01.png  http://x/p",
      "02.png  http://x/p  DOM still changing after 3 s, font readiness still pending after 5 s, 2 images still loading after 5 s (first: http://x/a.png), 1 image failed to load",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "snapseq: 02.png taken with DOM still changing after 3 s, font readiness still pending after 5 s, 2 images still loading after 5 s (first: http://x/a.png), 1 image failed to load  http://x/p",
    );
  });

  it("rethrows a failed screenshot with the readiness notes, or ok, and keeps the original as its cause", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    const original = new Error("page.screenshot: Timeout 3000ms exceeded.");
    page.screenshot.mockRejectedValueOnce(original);
    const ready = await seq.snap().catch((e: Error) => e);
    expect(ready).toBeInstanceOf(Error);
    expect((ready as Error).message).toBe("page.screenshot: Timeout 3000ms exceeded.; readiness: ok");
    expect((ready as Error).cause).toBe(original);

    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("scrollHeight")) return 900;
      if (src.includes("document.images")) return { pending: 1, first: "http://x/a.png", failed: 0, firstFailed: "" };
      return !src.includes("MutationObserver");
    });
    page.screenshot.mockRejectedValueOnce(original);
    await expect(seq.snap()).rejects.toThrow(
      "page.screenshot: Timeout 3000ms exceeded.; readiness: DOM still changing after 3 s, 1 image still loading after 5 s (first: http://x/a.png)",
    );
    expect(seq.shots).toEqual([]); // neither was listed
  });

  it("snapPage refuses a page whose height follows the viewport, and restores the viewport", async () => {
    const { page, viewports } = makePageStub();
    // Every measurement comes back taller than the viewport just set.
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("documentElement.scrollHeight")) return page.viewportSize().height + 500;
      if (src.includes("document.images")) return { pending: 0, first: "", failed: 0, firstFailed: "" };
      if (src.includes("querySelectorAll")) return ""; // no scroller to note instead
      return true;
    });
    const seq = createSequence(page, root, "cap");
    await expect(seq.snapPage()).rejects.toThrow("snap({ fullPage: true })");
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(viewports.at(-1)).toEqual({ width: 400, height: 300 });
  });

  it("snapPage names what the hooks noted when it refuses, as the refused shot is never listed", async () => {
    const { page } = makePageStub();
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const src = String(fn);
      if (src.includes("documentElement.scrollHeight")) return page.viewportSize().height + 500;
      if (src.includes("document.images")) return { pending: 0, first: "", failed: 0, firstFailed: "" };
      if (src.includes("querySelectorAll")) return ""; // no scroller to note instead
      return true;
    });
    const plugins: Plugin[] = [
      { name: "s", beforeSnap: async (shot) => void shot.notes.push("cannot read x.css: its viewport units stay live") },
    ];
    const seq = createSequence(page, root, "cap", { plugins, ctx: { device: "d1" } as SequenceContext });
    await expect(seq.snapPage()).rejects.toThrow(
      "Use snap({ fullPage: true }) for this page. Notes: cannot read x.css: its viewport units stay live",
    );
  });

  it("snapPage puts back the viewport, then the scroll position, and only into the document it read it from", async () => {
    const { page, events } = makePageStub();
    const seq = createSequence(page, root, "cap");
    await seq.snapPage();
    expect(events.slice(-3)).toEqual(["setViewportSize 300", "scroll", "scrollTo 1500"]);
    // A reload during the shot: a new document with its own timeOrigin, so nothing is scrolled.
    const reloaded = makeWindow(2, events);
    page.screenshot.mockImplementationOnce(async (opts: { path: string }) => {
      writeFileSync(opts.path, "png-stub");
      vi.stubGlobal("window", reloaded);
    });
    await seq.snapPage();
    expect(events.slice(-2)).toEqual(["setViewportSize 300", "scroll"]);
    expect(reloaded.scrollTo).not.toHaveBeenCalled();
  });

  it("snapPage never lets a failed restore hide the shot's own error, and fails on one after a shot that passed", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    page.setViewportSize.mockImplementation(async (size: { height: number }) => {
      if (size.height === 300) throw new Error("restore failed");
    });
    page.screenshot.mockRejectedValueOnce(new Error("boom"));
    await expect(seq.snapPage()).rejects.toThrow("boom");
    await expect(seq.snapPage()).rejects.toThrow("restore failed");
  });

  it("snapPage looks for an inner scroller on a page of about one screen, before growing, and then does not grow", async () => {
    const tall = makePageStub();
    await createSequence(tall.page, root, "tall").snapPage();
    expect(tall.events).not.toContain("container");
    // One screen and a body margin, no scroller: looked for, then grown as usual.
    const plain = makePageStub(316);
    await createSequence(plain.page, root, "plain").snapPage();
    expect(plain.events.indexOf("container")).toBeLessThan(plain.events.indexOf("setViewportSize 316"));
    const { page, events, viewports } = makePageStub(316, "main.content");
    const seq = createSequence(page, root, "cap");
    await seq.snapPage();
    expect(events).toContain("container");
    expect(viewports).toEqual([{ width: 400, height: 300 }]); // the restore only
    expect(lines(seq)).toEqual(["01.png  http://x/p  the page scrolls inside <main.content> not the document: scrollable content may be omitted"]);
  });

  describe("plugins", () => {
    const ctx = { device: "d1" } as SequenceContext;

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

    it("waits for the document, then runs beforeSnap hooks: before the readiness waits, and before snapPage reads and grows the viewport", async () => {
      const { page, events } = makePageStub();
      const plugins: Plugin[] = [{ name: "a", beforeSnap: async (shot) => void events.push(`beforeSnap written=${existsSync(shot.path)}`) }];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snapPage();
      // The scale factor is read once per sequence; then the scroll position and the height.
      expect(events.slice(0, 7)).toEqual([
        "waitForLoadState domcontentloaded",
        "ratio",
        "beforeSnap written=false",
        "viewportSize",
        "scroll",
        "height",
        "setViewportSize 900",
      ]);
      events.length = 0;
      await seq.snap();
      expect(events.slice(0, 3)).toEqual(["waitForLoadState domcontentloaded", "beforeSnap written=false", "wait"]);
    });

    it("runs afterGrow hooks after each grow of snapPage, before its readiness wait, and never for snap", async () => {
      const { page, events } = makePageStub(900);
      // Once grown, the page is 100 px taller: snapPage grows it a second time.
      const serve = page.evaluate.getMockImplementation();
      page.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) =>
        String(fn).includes("documentElement.scrollHeight") && events.includes("setViewportSize 900") ? (events.push("height"), 1000) : serve(fn, arg),
      );
      const plugins: Plugin[] = [{ name: "a", afterGrow: async (shot) => void events.push(`afterGrow ${shot.name}`) }];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snapPage();
      const resizes = events.flatMap((e, i) => (e.startsWith("setViewportSize") ? [events.slice(i, i + 3)] : []));
      expect(resizes).toEqual([
        ["setViewportSize 900", "afterGrow 01.png", "wait"],
        ["setViewportSize 1000", "afterGrow 01.png", "wait"],
        ["setViewportSize 300", "scroll", "scrollTo 1500"], // the restore runs none
      ]);
      events.length = 0;
      await seq.snap();
      expect(events.filter((e) => e.startsWith("afterGrow"))).toEqual([]);
    });

    it("runs afterRestore hooks once per snapPage, once the viewport and the scroll position are back, and never for snap", async () => {
      const { page, events } = makePageStub(900);
      const plugins: Plugin[] = [
        {
          name: "a",
          afterRestore: async (shot) => {
            const size = page.viewportSize(); // the device's again
            events.push(`afterRestore ${shot.name} ${size.height}`);
          },
        },
      ];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await seq.snapPage();
      expect(events.slice(-5)).toEqual(["setViewportSize 300", "scroll", "scrollTo 1500", "viewportSize", "afterRestore 01.png 300"]);
      expect(events.filter((e) => e.startsWith("afterRestore"))).toHaveLength(1);
      events.length = 0;
      await seq.snap();
      expect(events.filter((e) => e.startsWith("afterRestore"))).toEqual([]);
    });

    it("runs afterRestore when snapPage refuses the page, after the viewport is back, and keeps the refusal as the error", async () => {
      const { page, events } = makePageStub();
      page.evaluate.mockImplementation(async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("documentElement.scrollHeight")) return page.viewportSize().height + 500;
        if (src.includes("document.images")) return { pending: 0, first: "", failed: 0, firstFailed: "" };
        if (src.includes("querySelectorAll")) return ""; // no scroller to note instead
        return true;
      });
      const heights: number[] = [];
      const plugins: Plugin[] = [
        {
          name: "a",
          afterRestore: async () => {
            heights.push(page.viewportSize().height);
            throw new Error("late"); // swallowed: the refusal is the error
          },
        },
      ];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await expect(seq.snapPage()).rejects.toThrow("snap({ fullPage: true })");
      expect(heights).toEqual([300]);
      expect(events.filter((e) => e === "screenshot")).toEqual([]);
    });

    it("fails the sequence on an afterRestore that throws after a shot that was taken, naming the plugin and the shot", async () => {
      const { page } = makePageStub();
      const plugins: Plugin[] = [{ name: "a", afterRestore: async () => { throw new Error("late"); } }];
      const seq = createSequence(page, root, "cap", { plugins, ctx });
      await expect(seq.snapPage()).rejects.toThrow('snapseq: plugin "a" threw in afterRestore on 01.png: late');
      expect(lines(seq)).toEqual(["01.png  http://x/p"]); // the shot itself was listed
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
      expect(lines(seq)).toEqual(["01.png  http://x/later"]);
    });

    it("hands beforeSnap no notes and afterSnap the readiness notes", async () => {
      const { page } = makePageStub();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      page.evaluate.mockImplementation(async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("scrollHeight")) return 900;
        if (src.includes("document.images")) return { pending: 0, first: "", failed: 0, firstFailed: "" };
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
      expect(lines(seq)).toEqual(["01.png  http://x/p"]);
    });

    it("runs afterSnap hooks in listing order, after the file is written and before the shot is listed", async () => {
      const { page } = makePageStub();
      const events: string[] = [];
      const listed = () => seq.shots.map((s) => s.name).join(",");
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
        'a 02.png written=true ctx=true listed="01.png"',
        "b 02.png",
      ]);
      expect(listed()).toBe("01.png,02.png");
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

  it("listens once per pending image however many passes the image wait takes, wakes on each settle, and stops listening when it ends", async () => {
    // Images whose listeners are counted: the wait runs for real against them.
    const image = (name: string) => ({
      src: `http://x/${name}.png`,
      currentSrc: `http://x/${name}.png`,
      complete: false,
      naturalWidth: 1,
      loading: "eager",
      parentElement: null,
      adds: 0,
      live: { load: new Set<() => void>(), error: new Set<() => void>() } as Record<string, Set<() => void>>,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }),
      checkVisibility: () => true,
      decode: async () => undefined,
      addEventListener(type: string, fn: () => void, options?: { signal?: AbortSignal }) {
        this.adds++;
        this.live[type]!.add(fn);
        options?.signal?.addEventListener("abort", () => this.live[type]!.delete(fn));
      },
      removeEventListener(type: string, fn: () => void) {
        this.live[type]!.delete(fn);
      },
      load() {
        this.complete = true;
        for (const fn of [...this.live.load!]) fn();
      },
    });
    const images = ["a", "b", "c"].map(image);
    const [a, b, c] = images as [ReturnType<typeof image>, ReturnType<typeof image>, ReturnType<typeof image>];
    const { page } = makePageStub(); // stubs a window of its own, replaced below
    vi.stubGlobal("document", { images, documentElement: {}, body: {} });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("innerHeight", 300);
    vi.stubGlobal("getComputedStyle", () => ({ overflowX: "visible", overflowY: "visible", position: "static" }));
    page.evaluate.mockImplementation(async (fn: (arg: unknown) => unknown, arg: { maxMs: number }) => {
      const src = String(fn);
      if (!src.includes("document.images")) return src.includes("devicePixelRatio") ? 2 : true;
      // a loads, then its src is swapped on the same element, pending again; b and c load; a's second load is the
      // last event of all, so the wait ends long before the cap only if that load wakes it.
      setTimeout(() => a.load(), 20);
      setTimeout(() => void (a.complete = false), 30);
      setTimeout(() => b.load(), 40);
      setTimeout(() => c.load(), 60);
      setTimeout(() => a.load(), 100);
      return fn({ ...arg, maxMs: 2000 });
    });
    const seq = createSequence(page, root, "cap");
    const started = performance.now();
    await seq.snap();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(images.map((img) => img.adds)).toEqual([2, 2, 2]); // a load and an error listener each
    expect(images.map((img) => [img.live.load!.size, img.live.error!.size])).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(lines(seq)).toEqual(["01.png  http://x/p"]);
  });

  it("wipes a directory a hook wrote into its own on a rerun", async () => {
    const plugins: Plugin[] = [
      {
        name: "thumbs",
        afterSnap: async (shot) => {
          mkdirSync(join(root, "cap", "thumbnails"), { recursive: true });
          writeFileSync(join(root, "cap", "thumbnails", shot.name), "thumb");
        },
      },
    ];
    await createSequence(makePageStub().page, root, "cap", { plugins }).snap();
    expect(existsSync(join(root, "cap", "thumbnails", "01.png"))).toBe(true);
    expect(readdirSync(createSequence(makePageStub().page, root, "cap").dir)).toEqual([]);
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

  it("does not list a shot whose hook resolved after the sequence ended", async () => {
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
    await expect(late).rejects.toThrow("the sequence ended before 01.png was listed");
    expect(seq.shots).toHaveLength(0);
  });

  it("hands a hook its own copy of format and notes", async () => {
    const { page } = makePageStub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seq = createSequence(page, root, "cap", {
      plugins: [{ name: "mut", afterSnap: async (shot) => { shot.format.type = "jpeg"; shot.notes.push("x\ninjected"); } }],
    });
    await seq.snap();
    await seq.snap();
    expect(readdirSync(seq.dir).sort()).toEqual(["01.png", "02.png"]);
    expect(warn).not.toHaveBeenCalled(); // the pushed note never reached the terminal line
  });

  it("takes the scale factor from the context's option, and bounds what the page says when it is unset", async () => {
    const given = makePageStub();
    const seq = createSequence(given.page, root, "given", { deviceScaleFactor: 3 });
    await seq.snap();
    expect(seq.shots[0]?.deviceScaleFactor).toBe(3);
    expect(given.events).not.toContain("ratio");
    for (const [said, used] of [[1000, 16], [0, 0.1], [Number.NaN, 1], ["2", 1]] as const) {
      const { page } = makePageStub(900, "", said);
      const read = createSequence(page, root, `read${used}${typeof said}`);
      await read.snap();
      expect(read.shots[0]?.deviceScaleFactor).toBe(used);
    }
  });

  it("reads the device scale factor once per sequence and hands it to every shot, beforeSnap included", async () => {
    const { page } = makePageStub();
    const seen: number[] = [];
    const plugins: Plugin[] = [{ name: "d", beforeSnap: async (shot) => void seen.push(shot.deviceScaleFactor) }];
    const seq = createSequence(page, root, "cap", { plugins, ctx: { device: "d1" } as SequenceContext });
    await seq.snap();
    await seq.snapPage();
    expect(seen).toEqual([2, 2]);
    expect(seq.shots.map((s) => s.deviceScaleFactor)).toEqual([2, 2]);
    expect(page.evaluate.mock.calls.filter((c: unknown[]) => String(c[0]).includes("devicePixelRatio"))).toHaveLength(1);
  });
});
