import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SnapseqReporter, { type OutStream } from "../reporter.js";

function fakeTty(rows: number, columns = 80) {
  let text = "";
  let onResize: (() => void) | undefined;
  const stream: OutStream = {
    isTTY: true,
    rows,
    columns,
    write: (s: string) => (text += s),
    on: (_event, fn) => (onResize = fn),
  };
  return { stream, text: () => text, resize: () => onResize?.() };
}

const project = { name: "d1", testDir: "/t/snapseq", timeout: 600_000 };
const config = {
  metadata: { snapseq: { env: "dev", host: "http://h", run: "run1", screenshotsDir: "out" } },
  quiet: false,
  configFile: "/t/snapseq.config.ts",
  rootDir: "/t",
} as unknown as FullConfig;

function fakeTest(
  id: string,
  file: string,
  titles: string[] = ["sequence"],
  annotations: { type: string; description?: string }[] = [],
): TestCase {
  return {
    id,
    location: { file: `/t/snapseq/${file}`, line: 1, column: 1 },
    parent: { project: () => project },
    titlePath: () => ["", "d1", file, ...titles],
    annotations,
    timeout: 612_345, // what the shots pushed the deadline out to
  } as unknown as TestCase;
}

const shotStep = (title: string, error?: TestError): TestStep =>
  ({ category: "test.step", title, error }) as unknown as TestStep;

const result = (status: TestResult["status"], errors: TestError[] = [], duration = 1234) =>
  ({ status, errors, duration, annotations: [] }) as unknown as TestResult;

/** Without colors, to match on the text. */
const plain = (s: string): string => s.replace(/\x1b\[\d+m/g, "");

/** The frame drawn last, after the clear that preceded it. */
const lastFrame = (text: string): string => plain(text.slice(text.lastIndexOf("\x1b[0J") + 4));
/** The sequences and the "+N above / more" lines of a frame, top to bottom. */
const names = (frame: string): string[] => [...frame.matchAll(/(c\d) \/ d1|\+\d+ (?:above|more)/g)].map((m) => m[1] ?? m[0]);
/** A terminal of `rows` lines with `count` sequences planned and the run begun. */
const run = (rows: number, count: number, columns = 80) => {
  const tty = fakeTty(rows, columns);
  const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
  const tests = Array.from({ length: count }, (_, i) => fakeTest(`t${i}`, `c${i}.seq.ts`));
  r.onBegin(config, { allTests: () => tests } as unknown as Suite);
  return { tty, r, tests };
};

// A terminal that draws marks and colors, whatever the shell running the suite has set.
beforeEach(() => {
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("FORCE_COLOR", "");
  vi.stubEnv("SNAPSEQ_OPEN", "");
  vi.stubEnv("CI", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("SnapseqReporter", () => {
  it("counts a shot whatever the width of its number or its format, and says where a .jpg is", () => {
    const tty = fakeTty(10);
    const r = new SnapseqReporter({ stream: tty.stream });
    const a = fakeTest("t0", "c0.seq.ts", ["sequence"], []);
    r.onBegin(config, { allTests: () => [a] } as unknown as Suite);
    r.onTestBegin(a);
    r.onStepEnd(a, result("passed"), shotStep("01.png  http://h/a"));
    r.onStepEnd(a, result("passed"), shotStep("0002.png  http://h/b"));
    r.onStepBegin(a, result("passed"), shotStep("03.jpg  http://h/c"));
    expect(plain(tty.text())).toContain("2 shots");
    expect(plain(tty.text())).toContain("/c");
    r.onStepEnd(a, result("passed"), shotStep("03.jpg  http://h/c"));
    expect(plain(tty.text())).toContain("3 shots");
  });

  it("clips the live frame, counts completed shots, and prints a complete static summary", () => {
    const tty = fakeTty(10);
    const r = new SnapseqReporter({ stream: tty.stream });
    const tests = Array.from({ length: 10 }, (_, i) =>
      fakeTest(`t${i}`, `c${i}.seq.ts`, ["sequence"], i === 2 ? [{ type: "skip", description: "desktop only" }] : []),
    );
    r.onBegin(config, { allTests: () => tests } as unknown as Suite);
    // 10 rows do not fit in 10 terminal lines: 3 shown, the rest counted.
    expect(tty.text()).toContain("+7 more");
    expect(tty.text()).toContain("snapseq  dev  http://h  run1");

    const [a, b, c] = tests as [TestCase, TestCase, TestCase];
    r.onTestBegin(a);
    r.onStepEnd(a, result("passed"), shotStep("001.png"));
    r.onStepBegin(a, result("passed"), shotStep("002.png  http://h/pricing?x=1#top"));
    expect(plain(tty.text())).toMatch(/c0 \/ d1\s+1 shot  00:00  \/pricing\?x=1\n/); // how long, and where
    r.onStepEnd(a, result("passed"), shotStep("002.png  http://h/pricing?x=1#top"));
    expect(tty.text()).toContain("2 shots");
    r.onStepEnd(a, result("passed"), shotStep("003.png", { message: "boom" })); // failed shot: not counted
    r.onStepEnd(a, result("passed"), { category: "pw:api", title: "004.png" } as unknown as TestStep);
    r.onTestEnd(a, result("passed"));

    r.onTestBegin(b);
    r.onStepBegin(b, result("passed"), shotStep("001.png  http://h/checkout"));
    r.onStepEnd(b, result("passed"), shotStep("001.png  http://h/checkout", { message: "boom" }));
    r.onTestEnd(b, result("failed", [{ message: "boom\n  at x\n" }]));
    r.onTestBegin(c);
    r.onTestEnd(c, result("skipped"));
    r.onError({ message: "global bad" });
    r.onEnd({ status: "failed" } as FullResult);

    const out = tty.text();
    const colored = out.slice(out.lastIndexOf("\x1b[0J") + 4); // after the last frame clear
    const summary = plain(colored);
    expect(summary).toMatch(/✔ c0 \/ d1\s+2 shots\s+1\.2s/);
    expect(summary).toMatch(/✖ c1 \/ d1\s+0 shots\s+1\.2s\s+\/checkout\s+boom/); // where it died, then why
    expect(summary).toContain("         boom\n           at x\n");
    expect(summary).toMatch(/- c2 \/ d1\s+skipped  desktop only/);
    expect(summary).not.toContain("c3 / d1"); // queued when the run stopped: counted in the footer, not listed
    // Green and red marks, rows that did nothing dimmed whole.
    expect(colored).toContain("  \x1b[32m✔\x1b[39m c0 / d1");
    expect(colored).toContain("  \x1b[31m✖\x1b[39m c1 / d1");
    expect(colored).toMatch(/\x1b\[2m  - c2 \/ d1\s+skipped  desktop only\x1b\[22m/);
    // The cursor is never hidden: a killed run could not give it back.
    expect(out).not.toContain("\x1b[?25");
    expect(summary).toContain("global bad");
    expect(summary).toContain("1 passed, 1 failed, 1 skipped, 7 not run  2 shots  ");
    expect(summary).toContain("out/run1");
  });

  it("lists only the rows that ran, were skipped or were interrupted in the final summary, and counts every row in the footer", () => {
    const tty = fakeTty(24);
    const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
    const tests = [
      fakeTest("t0", "a.seq.ts"),
      fakeTest("t1", "b.seq.ts"),
      fakeTest("t2", "a-much-longer-sequence-name.seq.ts"), // never started
      fakeTest("t3", "c.seq.ts"), // never started
    ];
    r.onBegin(config, { allTests: () => tests } as unknown as Suite);
    r.onTestBegin(tests[0]!);
    r.onTestEnd(tests[0]!, result("passed"));
    r.onTestBegin(tests[1]!);
    r.onTestEnd(tests[1]!, result("interrupted"));
    r.onEnd({ status: "interrupted" } as FullResult);

    const out = tty.text();
    const summary = plain(out.slice(out.lastIndexOf("\x1b[0J") + 4));
    expect(summary).not.toContain("a-much-longer");
    expect(summary).not.toContain("c / d1");
    // The label column fits the rows shown, not the ones left out.
    expect(summary).toMatch(/✔ a \/ d1  0 shots  1\.2s\n/);
    expect(summary).toMatch(/✖ b \/ d1  0 shots  1\.2s\n/);
    expect(summary).toContain("1 passed, 1 interrupted, 2 not run  0 shots");
  });

  it("opens the run directory after an interactive run, and only then", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapseq-rep-"));
    mkdirSync(join(dir, "out", "run1"), { recursive: true });
    const cfg = { ...config, configFile: join(dir, "snapseq.config.ts"), rootDir: dir } as FullConfig;
    const t = fakeTest("t0", "home.seq.ts");
    const opened: string[] = [];

    const live = new SnapseqReporter({ stream: fakeTty(24).stream, open: (d) => opened.push(d) });
    live.onBegin(cfg, { allTests: () => [t] } as unknown as Suite);
    live.onEnd({ status: "passed" } as FullResult);
    expect(opened).toEqual([realpathSync(join(dir, "out", "run1"))]);

    const piped = new SnapseqReporter({ stream: { write: () => {} }, open: (d) => opened.push(d) });
    piped.onBegin(cfg, { allTests: () => [t] } as unknown as Suite);
    piped.onEnd({ status: "passed" } as FullResult);
    expect(opened).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not open the run directory under SNAPSEQ_OPEN=0 or false (any case) or CI, and still prints where it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapseq-rep-"));
    mkdirSync(join(dir, "out", "run1"), { recursive: true });
    const cfg = { ...config, configFile: join(dir, "snapseq.config.ts"), rootDir: dir } as FullConfig;
    const t = fakeTest("t0", "home.seq.ts");
    const opened: string[] = [];
    for (const [name, value] of [["SNAPSEQ_OPEN", "0"], ["SNAPSEQ_OPEN", "False"], ["CI", "true"]] as const) {
      vi.stubEnv(name, value);
      const tty = fakeTty(24);
      const r = new SnapseqReporter({ stream: tty.stream, open: (d) => opened.push(d) });
      r.onBegin(cfg, { allTests: () => [t] } as unknown as Suite);
      r.onEnd({ status: "passed" } as FullResult);
      expect(plain(tty.text())).toContain("out/run1");
      vi.stubEnv(name, "");
    }
    expect(opened).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the configured timeout, not the deadline the shots pushed out", () => {
    let text = "";
    const r = new SnapseqReporter({ stream: { write: (s: string) => (text += s) } });
    const t = fakeTest("t0", "home.seq.ts");
    r.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    r.onTestBegin(t);
    r.onTestEnd(
      t,
      result("timedOut", [
        { message: "\x1b[31mTest timeout of 612345.5ms exceeded.\x1b[39m\n    at /t/snapseq/home.seq.ts:3:1" },
      ]),
    );
    expect(text).toMatch(/TIME\s+home \/ d1\s+0 shots\s+1\.2s\s+No shot for 10 min\./);
    expect(text).not.toContain("612345");
    expect(text).toContain("at /t/snapseq/home.seq.ts:3:1");
  });

  it("keeps the plan's order like a todo list, and scrolls to the first unfinished row", () => {
    // It fits: a finished row stays above the running one, nothing jumps to the top.
    const a = run(24, 3);
    a.r.onTestBegin(a.tests[0]!);
    a.r.onTestEnd(a.tests[0]!, result("passed"));
    a.r.onTestBegin(a.tests[1]!);
    expect(names(lastFrame(a.tty.text()))).toEqual(["c0", "c1", "c2"]);
    expect(lastFrame(a.tty.text())).toMatch(/✔ c0 \/ d1.*\n  \S c1 \/ d1\s+0 shots.*\n  \. c2 \/ d1\s+queued/);
    a.r.onEnd({ status: "passed" } as FullResult);

    // Four lines for six rows: the top of the list first, then the window follows the work.
    const b = run(10, 6);
    expect(names(lastFrame(b.tty.text()))).toEqual(["c0", "c1", "c2", "+3 more"]);
    for (const i of [0, 1]) {
      b.r.onTestBegin(b.tests[i]!);
      b.r.onTestEnd(b.tests[i]!, result("passed"));
    }
    b.r.onTestBegin(b.tests[2]!);
    expect(names(lastFrame(b.tty.text()))).toEqual(["+1 above", "c1", "c2", "+3 more"]);
    for (const i of [2, 3, 4]) {
      if (i > 2) b.r.onTestBegin(b.tests[i]!);
      b.r.onTestEnd(b.tests[i]!, result("passed"));
    }
    b.r.onTestBegin(b.tests[5]!);
    expect(names(lastFrame(b.tty.text()))).toEqual(["+3 above", "c3", "c4", "c5"]);
    b.r.onEnd({ status: "passed" } as FullResult);
  });

  it("keeps the running row in view on a short terminal, and prints one line per event below 7 rows", () => {
    // Three sequences done, the fourth running, four queued; a frame plus the prompt must fit the screen.
    const go = (rows: number) => {
      const t = run(rows, 8);
      for (const i of [0, 1, 2]) {
        t.r.onTestBegin(t.tests[i]!);
        t.r.onTestEnd(t.tests[i]!, result("passed"));
      }
      t.r.onTestBegin(t.tests[3]!);
      const frame = lastFrame(t.tty.text());
      return { t, frame, height: frame.split("\n").length - 1 };
    };

    const seven = go(7);
    expect(names(seven.frame)).toEqual(["c3"]); // room for the row alone
    expect(seven.height).toBeLessThanOrEqual(6);
    const eight = go(8);
    expect(names(eight.frame)).toEqual(["c3", "+4 more"]);
    expect(eight.height).toBeLessThanOrEqual(7);
    const twelve = go(12);
    expect(names(twelve.frame)).toEqual(["+2 above", "c2", "c3", "c4", "c5", "+2 more"]);
    expect(twelve.height).toBeLessThanOrEqual(11);
    for (const x of [seven, eight, twelve]) x.t.r.onEnd({ status: "passed" } as FullResult);

    // Under 7 rows no frame fits at all: events, no cursor moves, as for a pipe.
    const six = run(6, 3);
    expect(six.tty.text()).toBe("  snapseq  dev  http://h  run1\n");
    six.r.onTestBegin(six.tests[0]!);
    six.r.onTestEnd(six.tests[0]!, result("passed"));
    six.r.onEnd({ status: "passed" } as FullResult);
    expect(six.tty.text()).not.toMatch(/\x1b\[\d*[A-HJK]/);
    expect(plain(six.tty.text()).split("\n").filter((l) => /c0 \/ d1/.test(l))).toHaveLength(2); // started, finished
  });

  it("draws the wait for the dev server in place, then hands over to the frame", () => {
    vi.useFakeTimers();
    const tty = fakeTty(24);
    const r = new SnapseqReporter({
      stream: tty.stream,
      open: () => {},
      server: { host: "http://localhost:3002", command: "pnpm dev" },
    });
    vi.advanceTimersByTime(900);
    expect(tty.text()).toBe(""); // a server that is already up never flashes the line
    vi.advanceTimersByTime(2200);
    expect(plain(tty.text())).toContain("waiting for http://localhost:3002  pnpm dev  00:03");
    expect(tty.text()).not.toContain("\n"); // one line, redrawn in place
    r.onBegin(config, { allTests: () => [fakeTest("t0", "home.seq.ts")] } as unknown as Suite);
    const out = tty.text();
    const frame = out.slice(out.lastIndexOf("\r\x1b[2K") + 5); // the line is cleared, the frame follows
    expect(frame).toContain("snapseq  dev  http://h  run1");
    expect(frame).not.toContain("waiting for");
    r.onEnd({ status: "passed" } as FullResult);

    // No server to start: nothing is drawn before the run begins.
    const quiet = fakeTty(24);
    const q = new SnapseqReporter({ stream: quiet.stream, open: () => {} });
    vi.advanceTimersByTime(5000);
    expect(quiet.text()).toBe("");
    q.onEnd({ status: "passed" } as FullResult);
  });

  it("keeps the marks and drops the colors under NO_COLOR", () => {
    vi.stubEnv("NO_COLOR", "1");
    const tty = fakeTty(24);
    const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
    const t = fakeTest("t0", "home.seq.ts");
    r.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    r.onTestBegin(t);
    r.onTestEnd(t, result("passed"));
    r.onEnd({ status: "passed" } as FullResult);
    expect(tty.text()).toContain("  ✔ home / d1");
    expect(tty.text()).not.toMatch(/\x1b\[\d+m/);

    // FORCE_COLOR=0 says the same; and a terminal 3 columns wide still gets one-line rows.
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("FORCE_COLOR", "0");
    const narrow = fakeTty(24, 3);
    const n = new SnapseqReporter({ stream: narrow.stream, open: () => {} });
    n.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    n.onEnd({ status: "passed" } as FullResult);
    expect(narrow.text()).not.toMatch(/\x1b\[\d+m/);
    const frame = narrow.text().slice(0, narrow.text().indexOf("\x1b["));
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(4); // indent, mark, space
  });

  it("keeps a failure's full details, and the page it died on, when the terminal is resized before the end", () => {
    const tty = fakeTty(24);
    const opened: string[] = [];
    const r = new SnapseqReporter({ stream: tty.stream, open: (d) => opened.push(d) });
    const a = fakeTest("t0", "a.seq.ts");
    const b = fakeTest("t1", "b.seq.ts");
    r.onBegin(config, { allTests: () => [a, b] } as unknown as Suite);
    r.onTestBegin(a);
    r.onStepBegin(a, result("passed"), shotStep("001.png  http://h/legal"));
    r.onStepEnd(a, result("passed"), shotStep("001.png  http://h/legal"));
    // The teardown shoots the page the sequence died on; not a shot to count.
    r.onStepBegin(a, result("passed"), shotStep("failed.png  http://h/contact-us"));
    r.onStepEnd(a, result("passed"), shotStep("failed.png  http://h/contact-us"));
    r.onTestEnd(a, result("failed", [{ message: "boom\n  at x\n  Call log:\n    - waiting for button\n" }]));
    expect(plain(tty.text())).not.toContain("Call log"); // the frame shows one line
    const before = tty.text().length;
    tty.resize();
    r.onTestBegin(b);
    r.onTestEnd(b, result("passed"));
    r.onEnd({ status: "failed" } as FullResult);
    const after = plain(tty.text().slice(before));
    expect(after).toMatch(/✖ a \/ d1\s+1 shot\s+1\.2s\s+\/contact-us\s+boom\n         boom\n           at x\n           Call log:\n             - waiting for button\n/);
    expect(after.split("Call log")).toHaveLength(2); // once, in full
    expect(after.split("✖ a / d1")).toHaveLength(2);
    expect(after.split("✔ b / d1")).toHaveLength(2);
    expect(after).toContain("1 passed, 1 failed  1 shot");
    expect(opened).toHaveLength(0); // the run dir does not exist here
    const raw = tty.text().length;
    tty.resize(); // a second resize has nothing left to flush
    expect(tty.text().length).toBe(raw);
  });

  it("prints an error's lines and colors, but no other control or format characters", () => {
    let text = "";
    const r = new SnapseqReporter({ stream: { write: (s: string) => (text += s) } });
    const t = fakeTest("t0", "home.seq.ts");
    r.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    r.onTestBegin(t);
    // A terminal title sequence and a right-to-left override, from a page's message.
    r.onTestEnd(t, result("failed", [{ message: "\x1b[31mbad\x1b[39m \x1b]0;x\x07title \u202eevil\n\tsecond line" }]));
    r.onError({ message: "global \x1b]0;y\x07\u202eerror" });
    expect(text).toContain("\x1b[31mbad\x1b[39m ]0;xtitle evil\n");
    expect(text).toContain("          second line"); // the indent, then the tab as a space
    expect(text).toContain("global ]0;yerror");
    expect(text).not.toMatch(/\x07|\u202e|\x1b\]/);
  });

  it("prints one line per event after a resize", () => {
    const tty = fakeTty(24);
    const r = new SnapseqReporter({ stream: tty.stream });
    const t = fakeTest("t0", "home.seq.ts", ["menu"]);
    r.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    r.onError({ message: "hidden by the frame" });
    tty.resize();
    const before = tty.text().length;
    r.onTestBegin(t);
    r.onTestEnd(t, result("passed"));
    r.onError({ message: "printed as it came" });
    const after = tty.text().slice(before);
    expect(after).not.toMatch(/\x1b\[\d*[A-HJK]/); // no cursor moves, no clears
    expect(after.trim().split("\n")).toHaveLength(3);
    expect(plain(after)).toMatch(/✔ home\/menu \/ d1\s+0 shots/);
    r.onEnd({ status: "failed" } as FullResult);
    const summary = tty.text().slice(before);
    // Each global error once: the one a frame hid comes in the summary, the other came as an event.
    expect(summary.split("hidden by the frame")).toHaveLength(2);
    expect(summary.split("printed as it came")).toHaveLength(2);
  });

  it("keeps the last real page when the teardown's page is a failed navigation", () => {
    const tty = fakeTty(24);
    const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
    const a = fakeTest("t0", "a.seq.ts");
    r.onBegin(config, { allTests: () => [a] } as unknown as Suite);
    r.onTestBegin(a);
    r.onStepBegin(a, result("passed"), shotStep("001.png  http://h/pricing"));
    // After a goto that never connected, the page the teardown shoots is not one.
    for (const url of ["chrome-error://chromewebdata/", "about:blank"]) {
      r.onStepBegin(a, result("passed"), shotStep(`failed.png  ${url}`));
    }
    r.onTestEnd(a, result("failed", [{ message: "boom" }]));
    expect(lastFrame(tty.text())).toMatch(/✖ a \/ d1\s+0 shots\s+1\.2s\s+\/pricing\s+boom/);
    r.onEnd({ status: "failed" } as FullResult);
  });

  it("cuts a long label and path from the left, so the count and the clock keep their columns", () => {
    const tty = fakeTty(12, 60);
    const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
    const t = fakeTest("t0", "clients/acme/campaign-2026/landing-pages/enterprise-pricing.seq.ts");
    r.onBegin(config, { allTests: () => [t] } as unknown as Suite);
    r.onTestBegin(t);
    r.onStepBegin(t, result("passed"), shotStep("07.png  http://h/pricing/enterprise"));
    for (let i = 0; i < 7; i++) r.onStepEnd(t, result("passed"), shotStep("07.png"));
    const row = lastFrame(tty.text()).split("\n").find((l) => l.includes("enterprise-pricing"))!;
    expect(row).toMatch(/^ {2}\S …pages\/enterprise-pricing \/ d1 {2}7 shots {2}00:00 {2}…rprise$/);
    expect(row.length).toBeLessThanOrEqual(59); // columns, less the one the cursor needs
    r.onEnd({ status: "passed" } as FullResult);
  });

  it("clears the waiting line when the terminal is resized before the run begins", () => {
    vi.useFakeTimers();
    const tty = fakeTty(24);
    const r = new SnapseqReporter({
      stream: tty.stream,
      open: () => {},
      server: { host: "http://localhost:3002", command: "pnpm dev" },
    });
    vi.advanceTimersByTime(3000);
    expect(plain(tty.text())).toContain("waiting for");
    const before = tty.text().length;
    tty.resize();
    r.onBegin(config, { allTests: () => [fakeTest("t0", "home.seq.ts")] } as unknown as Suite);
    expect(tty.text().slice(before)).toBe("\r\x1b[2K  snapseq  dev  http://h  run1\n"); // the header on a line of its own
    r.onEnd({ status: "passed" } as FullResult);
  });

  it("opens no window after Ctrl-C, and still does after a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapseq-rep-"));
    mkdirSync(join(dir, "out", "run1"), { recursive: true });
    const cfg = { ...config, configFile: join(dir, "snapseq.config.ts"), rootDir: dir } as FullConfig;
    const t = fakeTest("t0", "home.seq.ts");
    const opened: string[] = [];
    for (const status of ["interrupted", "failed"] as const) {
      const r = new SnapseqReporter({ stream: fakeTty(24).stream, open: (d) => opened.push(d) });
      r.onBegin(cfg, { allTests: () => [t] } as unknown as Suite);
      r.onEnd({ status } as FullResult);
      expect(opened).toHaveLength(status === "interrupted" ? 0 : 1);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows Latin letters with diacritics, decomposed or not, and keeps ? for wider scripts", () => {
    const tty = fakeTty(24);
    const r = new SnapseqReporter({ stream: tty.stream, open: () => {} });
    const tests = [
      fakeTest("t0", "über-uns.seq.ts"), // decomposed, as macOS lists file names
      fakeTest("t1", "abcdefgh.seq.ts"),
      fakeTest("t2", "日本.seq.ts"),
      fakeTest("t3", "m.seq.ts", ["sequence"], [{ type: "skip", description: "für mobile" }]),
    ];
    r.onBegin(config, { allTests: () => tests } as unknown as Suite);
    r.onTestBegin(tests[3]!);
    r.onTestEnd(tests[3]!, result("skipped"));
    const frame = lastFrame(tty.text());
    expect(frame).toContain("über-uns / d1");
    expect(frame).toMatch(/\?\? \/ d1\s+queued/);
    expect(frame).toContain("skipped  für mobile");
    // Composed, it is as wide as it looks: the next column starts where abcdefgh's does.
    const at = (name: string): number => {
      const line = frame.split("\n").find((l) => l.includes(name))!;
      return line.indexOf("queued");
    };
    expect(at("über-uns")).toBe(at("abcdefgh"));
    r.onEnd({ status: "passed" } as FullResult);
  });

  it("in an orchestration child, prints no heading, footer or window, lines its labels up to the parent's width, and names the env", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapseq-rep-"));
    mkdirSync(join(dir, "out", "run1"), { recursive: true });
    const snapseq = { ...(config.metadata as { snapseq: object }).snapseq, orchestration: { sequence: "c0", labelWidth: 20, showEnv: true } };
    const cfg = { ...config, metadata: { snapseq }, configFile: join(dir, "snapseq.config.ts"), rootDir: dir } as FullConfig;
    const opened: string[] = [];
    // A live frame (24 rows), then one line per event (5 rows).
    for (const tty of [fakeTty(24), fakeTty(5)]) {
      const r = new SnapseqReporter({ stream: tty.stream, open: (d) => opened.push(d) });
      const t = fakeTest("t0", "c0.seq.ts");
      r.onBegin(cfg, { allTests: () => [t] } as unknown as Suite);
      r.onTestBegin(t);
      r.onTestEnd(t, result("passed"));
      r.onEnd({ status: "passed" } as FullResult);
      const out = plain(tty.text());
      expect(out).not.toContain("snapseq  dev");
      expect(out).not.toContain("1 passed");
      expect(out).toMatch(/✔ c0 \/ d1 \(dev\) {9}0 shots  1\.2s\n$/); // 13 columns padded to 20, then the gap; the last line
    }
    expect(opened).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
