import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSequence, scrubUrl, type Shot, type SnapOptions } from "../sequence.js";
import { stabilize } from "../stabilize.js";

type Steps = NonNullable<NonNullable<Parameters<typeof createSequence>[3]>["stabilizer"]>;
// A stand-in for stabilize: the steps given, the others doing nothing.
const steps = (given: Partial<Steps>): Steps => ({
  beforeSnap: async () => {},
  afterGrow: async () => {},
  afterRestore: async () => {},
  ...given,
});

// Each listed shot as one line: name, URL, then its notes.
const lines = (seq: ReturnType<typeof createSequence>) => seq.shots.map((s) => `${s.name}  ${s.url}${s.notes.length > 0 ? `  ${s.notes.join(", ")}` : ""}`);

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

  // The wipe follows a linked folder to what it points at; the root itself may be a link.
  it("refuses to wipe through a symlink that leads outside its root, and takes a root that is one", () => {
    const outside = join(root, "outside", "desktop");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const out = join(root, "out", "run1");
    mkdirSync(out, { recursive: true });
    symlinkSync(join(root, "outside"), join(out, "pricing"));
    const { page } = makePageStub();
    expect(() => createSequence(page, out, join("pricing", "desktop"))).toThrow("not inside");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    symlinkSync(out, join(root, "linked-run"));
    expect(() => createSequence(page, join(root, "linked-run"), join("home", "desktop"))).not.toThrow();
    // A link above that leads back to the root itself: the whole screenshots dir.
    symlinkSync(join(root, "out"), join(out, "loop"));
    expect(() => createSequence(page, out, join("loop", "run1"))).toThrow("not inside");
    expect(existsSync(join(out, "pricing"))).toBe(true);
    // The device folder itself a link: the wipe removes the link, not what it points at.
    const archive = join(root, "archive", "desktop");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "keep.txt"), "keep");
    mkdirSync(join(out, "about"));
    symlinkSync(archive, join(out, "about", "desktop"));
    expect(() => createSequence(page, out, join("about", "desktop"))).not.toThrow();
    expect(existsSync(join(archive, "keep.txt"))).toBe(true);
  });

  it("records a readiness cap on the shot and warns, and says nothing otherwise; beforeSnap sees no notes either way", async () => {
    const { page } = makePageStub();
    const seen: string[][] = [];
    const seq = createSequence(page, root, "cap", { stabilizer: steps({ beforeSnap: async (shot) => void seen.push([...shot.notes]) }) });
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
    expect(seen).toEqual([[], []]);
  });

  it("names a URL without its credentials, signed query or fragment, an image's wrapped url= with them stripped too, and a data: URL by its kind", async () => {
    expect(scrubUrl("https://user:pw@cdn.x/a/site.css?sig=s3cr3t&exp=1#top")).toBe("https://cdn.x/a/site.css");
    const { page } = makePageStub();
    const serve = page.evaluate.getMockImplementation();
    // The wrapped URL's credentials are encoded twice, as %253A and %2540.
    const first = "https://user:pw@x.test/_next/image?url=https%3A%2F%2Fadmin%253Asecret%2540cdn.x%2Fhero.png%3Ftoken%3Dt&w=640&sig=s#f";
    page.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) =>
      String(fn).includes("document.images") ? { pending: 1, first, failed: 1, firstFailed: "data:" } : serve(fn, arg),
    );
    const seq = createSequence(page, root, "cap");
    await seq.snap();
    expect(seq.shots[0]?.notes).toEqual([
      "1 image still loading after 5 s (first: https://x.test/_next/image?url=https://cdn.x/hero.png)",
      "1 image failed to load (first: a data: URL)",
    ]);
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

  it("snapPage grows again to the content's bottom when scrollHeight reads unchanged but the page got shorter, never below the device viewport", async () => {
    // boxes: where the content ends by its boxes. scroll: the height of the content as scrollHeight sees it, never below the viewport.
    const run = async (boxes: number, scroll: number) => {
      const { page, viewports } = makePageStub(900); // 900 before the first grow
      const serve = page.evaluate.getMockImplementation();
      page.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) => {
        const src = String(fn);
        if (src.includes("getBoundingClientRect")) return boxes;
        if (src.includes("documentElement.scrollHeight") && viewports.length > 0) return Math.max(viewports.at(-1)!.height, scroll);
        return serve(fn, arg);
      });
      let grows = 0;
      await createSequence(page, root, "cap", { stabilizer: steps({ afterGrow: async () => void grows++ }) }).snapPage();
      return { heights: viewports.map((v) => v.height), grows };
    };
    expect(await run(700, 700)).toEqual({ heights: [900, 700, 300], grows: 2 }); // grown, grown again to the content, restored
    expect(await run(900, 900)).toEqual({ heights: [900, 300], grows: 1 }); // as tall as it was: no second grow
    expect(await run(899.5, 900)).toEqual({ heights: [900, 300], grows: 1 }); // less than 1 px shorter is rounding
    expect(await run(200, 200)).toEqual({ heights: [900, 300, 300], grows: 2 }); // not below the device's 300 px
    // The boxes read short (text overflowing a box): scrollHeight still says 900 at 700, so it goes back to 900 and is shot there.
    expect(await run(700, 900)).toEqual({ heights: [900, 700, 900, 300], grows: 3 });
  });

  it("snapPage reads the height once more when the first grow measured stable, and refuses a page that grew since", async () => {
    const { page } = makePageStub(900);
    const serve = page.evaluate.getMockImplementation();
    let reads = 0;
    // Plain height reads: 900 before and after the grow, 1400 at the third. The boxes' measure gets the stub's 900.
    page.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) => {
      const src = String(fn);
      if (src.includes("documentElement.scrollHeight") && !src.includes("getBoundingClientRect")) return ++reads > 2 ? 1400 : 900;
      return serve(fn, arg);
    });
    await expect(createSequence(page, root, "cap").snapPage()).rejects.toThrow("the document grew from 900 to 1400 px");
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

  describe("stabilize steps", () => {
    it("passes what beforeSnap put in the options to the screenshot, never a path or type the sequence gave, and keeps what the sequence gave", async () => {
      const { page } = makePageStub();
      const stabilizer = steps({ beforeSnap: async (shot) => void (shot.options.animations = "disabled") });
      const seq = createSequence(page, root, "cap", { stabilizer });
      // An untyped caller can still pass a path or a type.
      await seq.snap({ label: "Hero", mask: ["x"], path: "evil", type: "jpeg" } as unknown as SnapOptions);
      const call = page.screenshot.mock.calls[0]?.[0];
      expect(call).toEqual({ label: "Hero", mask: ["x"], animations: "disabled", path: join(seq.dir, "01.png") });
      expect(call.type).toBeUndefined(); // the config's: unset, so PNG
      expect(seq.shots[0]?.options).toEqual({ label: "Hero", mask: ["x"], path: "evil", type: "jpeg", animations: "disabled" });
      expect(seq.shots[0]?.given).toEqual({ label: "Hero", path: "evil", type: "jpeg" }); // the mask left out
    });

    it("waits for the document, then runs beforeSnap hooks: before the readiness waits, and before snapPage reads and grows the viewport", async () => {
      const { page, events } = makePageStub();
      const stabilizer = steps({ beforeSnap: async (shot) => void events.push(`beforeSnap written=${existsSync(shot.path)}`) });
      const seq = createSequence(page, root, "cap", { stabilizer });
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
      const stabilizer = steps({ afterGrow: async (shot) => void events.push(`afterGrow ${shot.name}`) });
      const seq = createSequence(page, root, "cap", { stabilizer });
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
      const stabilizer = steps({
        afterRestore: async (shot) => {
          const size = page.viewportSize(); // the device's again
          events.push(`afterRestore ${shot.name} ${size.height}`);
        },
      });
      const seq = createSequence(page, root, "cap", { stabilizer });
      await seq.snapPage();
      expect(events.slice(-5)).toEqual(["setViewportSize 300", "scroll", "scrollTo 1500", "viewportSize", "afterRestore 01.png 300"]);
      expect(events.filter((e) => e.startsWith("afterRestore"))).toHaveLength(1);
      events.length = 0;
      await seq.snap();
      expect(events.filter((e) => e.startsWith("afterRestore"))).toEqual([]);
    });

    it("refuses a page whose height follows the viewport, naming what beforeSnap noted, and runs afterRestore once the viewport is back, keeping the refusal as the error", async () => {
      const { page, events } = makePageStub();
      // Every measurement comes back taller than the viewport just set.
      page.evaluate.mockImplementation(async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("documentElement.scrollHeight")) return page.viewportSize().height + 500;
        if (src.includes("document.images")) return { pending: 0, first: "", failed: 0, firstFailed: "" };
        if (src.includes("querySelectorAll")) return ""; // no scroller to note instead
        return true;
      });
      const heights: number[] = [];
      const stabilizer = steps({
        beforeSnap: async (shot) => void shot.notes.push("cannot read x.css: its viewport units stay live"),
        afterRestore: async () => {
          heights.push(page.viewportSize().height);
          throw new Error("late"); // swallowed: the refusal is the error
        },
      });
      const seq = createSequence(page, root, "cap", { stabilizer });
      await expect(seq.snapPage()).rejects.toThrow(
        "Use snap({ fullPage: true }) for this page. Notes: cannot read x.css: its viewport units stay live",
      );
      expect(heights).toEqual([300]);
      expect(events.filter((e) => e === "screenshot")).toEqual([]);
    });

    it("fails the sequence on an afterRestore that throws after a shot that was taken", async () => {
      const { page } = makePageStub();
      const stabilizer = steps({ afterRestore: async () => { throw new Error("late"); } });
      const seq = createSequence(page, root, "cap", { stabilizer });
      await expect(seq.snapPage()).rejects.toThrow("late");
      expect(lines(seq)).toEqual(["01.png  http://x/p"]); // the shot itself was listed
    });

    it("names stabilize, beforeSnap and the shot when a step of the real stabilize throws", async () => {
      const gone = new Error("gone");
      const page = { evaluate: async () => { throw gone; } };
      const shot = { name: "01.png", options: {}, notes: [] } as unknown as Shot;
      await expect(stabilize({}, page as never).beforeSnap(shot)).rejects.toMatchObject({
        message: "snapseq: stabilize threw in beforeSnap on 01.png: gone",
        cause: gone,
      });
    });

    it("names stabilize and begin when the real stabilize's begin throws", async () => {
      const page = { addInitScript: async () => { throw new Error("csp"); } };
      await expect(stabilize({ motion: true }, page as never).begin()).rejects.toThrow("snapseq: stabilize threw in begin: csp");
    });

    it("titles and lists a shot with the URL at screenshot time, after the page changed it during the waits", async () => {
      const { page } = makePageStub();
      const titles: string[] = [];
      const serve = page.evaluate.getMockImplementation();
      page.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) => {
        if (String(fn).includes("MutationObserver")) page.url = () => "http://x/later"; // a router's replaceState while the DOM settles
        return serve(fn, arg);
      });
      const seq = createSequence(page, root, "cap", { wrap: (title, shoot) => (titles.push(title), shoot()) });
      await seq.snap();
      expect(titles).toEqual(["01.png  http://x/later"]);
      expect(lines(seq)).toEqual(["01.png  http://x/later"]);
    });

    it("fails the shot when beforeSnap throws, before any screenshot; the number is given back", async () => {
      const { page } = makePageStub();
      const kaput = new Error("kaput");
      let thrown = false;
      const seq = createSequence(page, root, "cap", {
        stabilizer: steps({ beforeSnap: async () => { if (!thrown) { thrown = true; throw kaput; } } }),
      });
      await expect(seq.snap()).rejects.toBe(kaput);
      expect(page.screenshot).not.toHaveBeenCalled();
      await seq.snap();
      expect(lines(seq)).toEqual(["01.png  http://x/p"]);
    });

    it("writes .jpg files when the format is jpeg, and lists every shot with its name, path, url, index, options and notes", async () => {
      const { page } = makePageStub();
      const seq = createSequence(page, root, "cap", { format: { type: "jpeg", quality: 60 } });
      await seq.snapPage({ omitBackground: true });
      await seq.snap();
      expect(readdirSync(seq.dir).sort()).toEqual(["01.jpg", "02.jpg"]);
      // The format's type and quality go through to each screenshot call; a shot's option stays with that shot.
      expect(page.screenshot.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        { path: join(seq.dir, "01.jpg"), type: "jpeg", quality: 60, omitBackground: true },
        { path: join(seq.dir, "02.jpg"), type: "jpeg", quality: 60 },
      ]);
      const shot = (n: number, options: SnapOptions) => ({
        name: `0${n}.jpg`,
        path: join(seq.dir, `0${n}.jpg`),
        url: "http://x/p",
        index: n,
        options,
        given: options,
        notes: [],
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

  it("wipes a directory written into its own on a rerun", async () => {
    await createSequence(makePageStub().page, root, "cap").snap();
    mkdirSync(join(root, "cap", "thumbnails"));
    writeFileSync(join(root, "cap", "thumbnails", "01.png"), "thumb");
    expect(readdirSync(createSequence(makePageStub().page, root, "cap").dir)).toEqual([]);
  });

  it("records what snap and snapPage were given at the call, so a change to the object while the shot waits does not reach it", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    for (const take of [seq.snap, seq.snapPage]) {
      const options = { label: { text: "Hero" } } as unknown as SnapOptions;
      const pending = take(options);
      (options as unknown as { label: { text: string } }).label.text = "changed";
      await pending;
    }
    expect(seq.shots.map((s) => s.given)).toEqual([{ label: { text: "Hero" } }, { label: { text: "Hero" } }]);
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

  it("reads the device scale factor once per sequence and hands it to every shot", async () => {
    const { page } = makePageStub();
    const seq = createSequence(page, root, "cap");
    await seq.snap();
    await seq.snapPage();
    expect(seq.shots.map((s) => s.deviceScaleFactor)).toEqual([2, 2]);
    expect(page.evaluate.mock.calls.filter((c: unknown[]) => String(c[0]).includes("devicePixelRatio"))).toHaveLength(1);
  });
});
