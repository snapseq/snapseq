// Live terminal view of a run: a waiting line while the dev server comes up,
// then one line per sequence and device with a spinner and the shot count, then
// a frozen summary with errors and the run directory. Zero dependencies.
// Playwright owns exit codes and Ctrl-C; this only draws.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { clearScreenDown, moveCursor } from "node:readline";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import type { SnapseqMetadata } from "./define.js";

type State = TestResult["status"] | "queued" | "running" | "not run";

interface Row {
  label: string;
  state: State;
  shots: number;
  duration: number;
  error?: string;
  /** Why a sequence was skipped. */
  note?: string;
  /** Path of the sequence's last shot, or of the page it died on. */
  at?: string;
  /** Its final line went out as an event, errors and all. */
  reported?: boolean;
  /** When the sequence began, for the running row's clock. */
  started?: number;
}

/** What the reporter needs from stdout; tests pass a fake. */
export interface OutStream {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(s: string): unknown;
  on?(event: "resize", fn: () => void): unknown;
}

// `01.png  http://host/path` (or `.jpg`): the file, then the URL it is taken at.
const SHOT = /^\d+\.(?:png|jpg)(?:  (.+))?$/;
// The same, plus the teardown's `failed.png  <url>`: where a sequence is, or died.
const AT = /^(?:\d+\.(?:png|jpg)|failed\.png)  (.+)$/;
const SPINNER = ["|", "/", "-", "\\"];
const GLYPH: Record<State, string> = {
  queued: ".",
  running: "",
  passed: "ok",
  failed: "FAIL",
  timedOut: "TIME",
  skipped: "skip",
  interrupted: "int",
  "not run": "-",
};
// Where the terminal can draw them: a braille spinner and one-column marks,
// the look of ora without the dependency.
const FANCY_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FANCY_GLYPH: Record<State, string> = {
  queued: ".",
  running: "",
  passed: "✔",
  failed: "✖",
  timedOut: "✖",
  skipped: "-",
  interrupted: "✖",
  "not run": ".",
};
// SGR foreground for a row's mark; rows that did nothing are dimmed whole.
const COLOR: Partial<Record<State, number>> = {
  running: 36,
  passed: 32,
  failed: 31,
  timedOut: 31,
  interrupted: 31,
};
// Fewest rows a frame fits: header, blank, one sequence, blank, footer, the prompt, and a line to spare.
const MIN_ROWS = 7;
const DIM: ReadonlySet<State> = new Set<State>(["queued", "not run", "skipped"]);
// Frame rows must be exactly one terminal line each: dynamic text carries no
// ANSI and no wide glyphs; marks and colors are added after the clip.
// Latin letters with diacritics (U+00A0 to U+024F) and the ellipsis are one column wide and pass; the rest is "?".
const ascii = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .normalize("NFC")
    .replace(/[^\x20-\x7e\u00a0-\u024f\u2026]/g, "?");
// The end of a label or a path tells it apart: a text too long for its columns loses its left.
const left = (s: string, n: number): string =>
  s.length <= n ? s : `\u2026${s.slice(s.length - Math.max(n - 1, 0))}`;
const errorText = (e: TestError): string => e.message ?? e.value ?? "unknown error";
// Error text carries what a page or a sequence put in a message: keep the lines and the colors, drop what moves the
// cursor, retitles the terminal or reorders the text (other control and format characters). A tab is a space.
const printable = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*m|[\p{Cc}\p{Cf}]/gu, (m) => (m === "\t" ? " " : m === "\n" || m.length > 1 ? m : ""));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const plural = (n: number): string => `${n} shot${n === 1 ? "" : "s"}`;
const span = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : seconds(ms));
// Every shot pushes the deadline out, so Playwright's number is not what the
// author configured; say what they did set. Appears once as the error and once
// more in whatever call the deadline interrupted; may be wrapped in red.
const TIMEOUT_MSG = /(?:\x1b\[[0-9;]*m)*Test timeout of [\d.]+ms exceeded\./g;

// Playwright reports files through resolved symlinks (macOS /var → /private/var)
// while configured dirs keep their spelling; compare like with like.
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Show a directory in Finder, Explorer or the desktop's file manager; silent when there is none. */
function openInFileManager(dir: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [dir], { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

/** `nested/pricing / desktop`, the same identity the screenshots directory uses. */
function labelOf(test: TestCase): string {
  const project = test.parent.project();
  const file = project
    ? relative(real(project.testDir), real(test.location.file))
    : test.location.file;
  const base = file.replace(/\.seq\.[cm]?[jt]s$/, "");
  const titles = test.titlePath().slice(3); // root, project, file
  const path = titles.length === 1 && titles[0] === "sequence" ? base : [base, ...titles].join("/");
  return `${path} / ${project?.name ?? ""}`.normalize("NFC"); // macOS hands file names over decomposed
}

export default class SnapseqReporter implements Reporter {
  private out: OutStream;
  private open: (dir: string) => void;
  /** In-place frame; false means one line per event (CI, odd terminals, under MIN_ROWS rows, after a resize). */
  private live: boolean;
  private rows = new Map<string, Row>();
  private meta: SnapseqMetadata | undefined;
  private runDir = "";
  private runDirAbsolute = "";
  private quiet = false;
  private start = Date.now();
  private frameLines = 0;
  private tick = 0;
  private timer: NodeJS.Timeout | undefined;
  private partialLine = false;
  private globalErrors: string[] = [];
  /** Braille and marks instead of words. */
  private fancy: boolean;
  private color: boolean;
  /** The dev server this run may be starting; named on the waiting line. */
  private server: { host: string; command: string } | undefined;
  private begun = false;
  private waiting = false;
  /** A frame was drawn at some point: someone is watching. A terminal too short for a frame counts too. */
  private drawn = false;
  private readonly terminal: boolean;

  constructor(
    options: {
      stream?: OutStream;
      open?: (dir: string) => void;
      server?: { host: string; command: string };
    } = {},
  ) {
    this.out = options.stream ?? process.stdout;
    this.open = options.open ?? openInFileManager;
    this.server = options.server;
    this.terminal = !!this.out.isTTY && this.out.columns !== undefined;
    this.live = this.terminal && (this.out.rows ?? 0) >= MIN_ROWS;
    this.fancy =
      !!this.out.isTTY &&
      process.env.TERM !== "linux" &&
      (process.platform !== "win32" || !!process.env.WT_SESSION);
    this.color = this.fancy && !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0";
    // A resize invalidates the cursor arithmetic; print events from then on.
    // The last frame stays as it was, its errors clipped to a line, so what it
    // held is printed in full once, as events would have.
    this.out.on?.("resize", () => {
      if (!this.live) return;
      this.live = false;
      this.frameLines = 0;
      if (this.waiting) this.out.write("\r\x1b[2K"); // the header must not land on the waiting line
      this.waiting = false;
      this.flush();
    });
    // Playwright builds reporters before it starts the dev server and calls
    // onBegin only once that is up, so the timer starts here: the wait is drawn.
    if (this.live) {
      this.timer = setInterval(() => this.render(), 100);
      this.timer.unref();
    }
  }

  printsToStdio(): boolean {
    return true;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.meta = (config.metadata as { snapseq?: SnapseqMetadata }).snapseq;
    this.quiet = config.quiet;
    if (this.meta) {
      const configDir = config.configFile ? dirname(config.configFile) : config.rootDir;
      this.runDirAbsolute = resolve(real(configDir), this.meta.screenshotsDir, this.meta.run);
      this.runDir = relative(real(process.cwd()), this.runDirAbsolute);
    }
    for (const test of suite.allTests()) this.row(test);
    this.begun = true;
    if (this.live) this.render();
    else this.out.write(`${this.header()}\n`);
  }

  onTestBegin(test: TestCase): void {
    const row = this.row(test);
    row.state = "running";
    row.started = Date.now();
    this.event(row);
  }

  // A shot is starting, or the teardown is shooting the page a sequence died on: say where.
  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const url = step.category === "test.step" ? AT.exec(step.title)?.[1] : undefined;
    // about:blank and chrome-error:// are not pages: the last real one stays.
    if (!url || !/^https?:\/\//i.test(url)) return;
    try {
      const u = new URL(url);
      this.row(test).at = u.pathname + u.search;
    } catch {
      this.row(test).at = url;
    }
    if (this.live) this.render();
  }

  // Each shot is a step named after its file; count the ones that completed.
  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "test.step" || !SHOT.test(step.title) || step.error) return;
    this.row(test).shots += 1;
    if (this.live) this.render();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const row = this.row(test);
    row.state = result.status;
    row.duration = result.duration;
    if (result.errors.length > 0) row.error = result.errors.map(errorText).join("\n");
    if (result.status === "timedOut" && row.error) {
      // test.timeout is the pushed-out value by now; the project's is what was set.
      const configured = test.parent.project()?.timeout ?? test.timeout;
      row.error = row.error.replace(TIMEOUT_MSG, `No shot for ${span(configured)}.`);
    }
    if (result.status === "skipped") {
      row.note = [...result.annotations, ...test.annotations].find(
        (a) => a.type === "skip" || a.type === "fixme",
      )?.description;
    }
    this.event(row);
  }

  // A frame hides errors until the summary; event mode prints them as they come.
  onError(error: TestError): void {
    if (this.live) this.globalErrors.push(printable(errorText(error)));
    else this.out.write(`${printable(errorText(error))}\n`);
  }

  onStdOut(chunk: string | Buffer): void {
    this.forward(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    this.forward(chunk);
  }

  onEnd(result: FullResult): void {
    if (this.timer) clearInterval(this.timer);
    for (const row of this.rows.values()) if (row.state === "queued") row.state = "not run";
    const hadFrame = this.live;
    this.clearFrame();
    this.live = false;

    const lines: string[] = [""];
    // The frame is gone; print every row that ran once. Event mode already printed them.
    // Rows that never ran are the footer's count: after a stop at the first
    // failure they would bury the failure under pages of "not run".
    if (hadFrame) {
      const rows = [...this.rows.values()].filter((r) => r.state !== "not run");
      const width = Math.max(...rows.map((r) => r.label.length), 1);
      for (const row of rows) lines.push(this.line(row, width), ...this.errorLines(row));
    }
    if (this.globalErrors.length > 0) lines.push("", ...this.globalErrors);
    lines.push("", this.footer(), "");
    this.out.write(`${lines.join("\n")}\n`);
    // Someone is watching: show them the shots. Pipes and CI never get a window, SNAPSEQ_OPEN=0 (or false) keeps it
    // closed, and Ctrl-C leaves a directory nobody wants to look at.
    // CI is checked here too, not only where the reporter is chosen: a config or --reporter can name this one anywhere.
    if (
      (this.drawn || this.terminal) &&
      result.status !== "interrupted" &&
      !/^(0|false)$/i.test(process.env.SNAPSEQ_OPEN ?? "") &&
      !process.env.CI &&
      this.runDirAbsolute &&
      existsSync(this.runDirAbsolute)
    ) {
      this.open(this.runDirAbsolute);
    }
  }

  private row(test: TestCase): Row {
    let row = this.rows.get(test.id);
    if (!row) {
      row = { label: labelOf(test), state: "queued", shots: 0, duration: 0 };
      this.rows.set(test.id, row);
    }
    return row;
  }

  private event(row: Row): void {
    if (this.live) {
      this.render();
      return;
    }
    const lines = [this.line(row, row.label.length)];
    if (row.state !== "running") {
      lines.push(...this.errorLines(row));
      row.reported = true;
    }
    this.out.write(`${lines.join("\n")}\n`);
  }

  /** Every finished row the frame was showing, once, in full. */
  private flush(): void {
    const lines: string[] = [];
    for (const row of this.rows.values()) {
      if (row.reported || row.state === "queued" || row.state === "running") continue;
      row.reported = true;
      lines.push(this.line(row, row.label.length), ...this.errorLines(row));
    }
    if (lines.length > 0) this.out.write(`${lines.join("\n")}\n`);
  }

  private errorLines(row: Row): string[] {
    if (!row.error) return [];
    return printable(row.error).trimEnd().split("\n").map((l) => `         ${l}`);
  }

  private forward(chunk: string | Buffer): void {
    if (this.quiet) return;
    const text = String(chunk);
    if (this.live) this.clearFrame();
    this.out.write(text);
    this.partialLine = !text.endsWith("\n");
    if (this.live && !this.partialLine) this.render();
  }

  private header(): string {
    const m = this.meta;
    const parts = ["snapseq", m?.env, m?.host, m?.run].filter(Boolean);
    return `  ${parts.join("  ")}`;
  }

  private footer(): string {
    const rows = [...this.rows.values()];
    const counts = (["passed", "failed", "timedOut", "interrupted", "skipped", "not run"] as State[])
      .map((s) => [rows.filter((r) => r.state === s).length, s] as const)
      .filter(([n]) => n > 0)
      .map(([n, s]) => `${n} ${s}`);
    const done = rows.filter((r) => r.state !== "queued" && r.state !== "running").length;
    const shots = rows.reduce((n, r) => n + r.shots, 0);
    const head = counts.length > 0 ? counts.join(", ") : `${done}/${rows.length} done`;
    const tail = this.runDir || clock(Date.now() - this.start);
    return `  ${head}  ${plural(shots)}  ${tail}`;
  }

  private spinner(): string {
    const frames = this.fancy ? FANCY_SPINNER : SPINNER;
    return frames[this.tick % frames.length]!;
  }

  /** A row's mark, then its text: colored or dimmed where the terminal takes it. */
  private compose(row: Row, text: string): string {
    const glyph =
      row.state !== "running"
        ? (this.fancy ? FANCY_GLYPH : GLYPH)[row.state]
        : this.live
          ? this.spinner()
          : "..";
    const mark = glyph.padEnd(this.fancy ? 1 : 4);
    if (!this.color) return `  ${mark} ${text}`;
    if (DIM.has(row.state)) return `\x1b[2m  ${mark} ${text}\x1b[22m`;
    const code = COLOR[row.state];
    return code ? `  \x1b[${code}m${mark}\x1b[39m ${text}` : `  ${mark} ${text}`;
  }

  private line(row: Row, width: number): string {
    return this.compose(row, this.text(row, width));
  }

  private text(row: Row, width: number, room = Infinity): string {
    let detail: string;
    const where = (): string => `  ${left(ascii(row.at ?? ""), room - width - detail.length - 4)}`;
    if (row.state === "running") {
      detail = plural(row.shots);
      // A slow page shows before it finishes. Events print once, so no clock there.
      if (this.live && row.started !== undefined) detail += `  ${clock(Date.now() - row.started)}`;
      if (row.at) detail += where();
    } else if (row.state === "queued" || row.state === "not run" || row.state === "skipped") {
      detail = row.note ? `${row.state}  ${ascii(row.note)}` : row.state;
    } else {
      detail = `${plural(row.shots)}  ${seconds(row.duration)}`;
      // Where it died, then why.
      if (row.error && row.at) detail += where();
      if (row.error) detail += `  ${ascii(row.error.split("\n")[0] ?? "")}`;
    }
    return `${left(row.label, width).padEnd(width)}  ${detail}`;
  }

  private render(): void {
    if (!this.live || this.partialLine) return;
    const columns = (this.out.columns ?? 80) - 1;
    if (!this.begun) {
      // One line, redrawn in place and never ended: whatever the server prints
      // to stderr meanwhile lands after it instead of under a miscounted frame.
      // Not in the first second: a server that is already up never shows it.
      if (!this.server || Date.now() - this.start < 1000) return;
      const text = `waiting for ${this.server.host}  ${this.server.command}  ${clock(Date.now() - this.start)}`;
      const mark = this.color ? `\x1b[36m${this.spinner()}\x1b[39m` : this.spinner();
      this.out.write(`\r\x1b[2K  ${mark} ${ascii(text).slice(0, Math.max(0, columns - 4))}`);
      this.waiting = true;
      this.tick += 1;
      return;
    }
    const maxRows = Math.max(1, (this.out.rows ?? 24) - 6); // header, blank, blank, footer, prompt
    // A todo list: rows stay in the order the run takes them and change in
    // place. When it does not fit it scrolls: the row to run is always in view,
    // the last finished row above it and queued rows below as far as there is
    // room, and a line each for what is hidden gives way before any row does.
    const rows = [...this.rows.values()];
    let start = 0;
    let end = rows.length;
    if (rows.length > maxRows) {
      const i = rows.findIndex((r) => r.state === "running" || r.state === "queued");
      const next = i < 0 ? rows.length - 1 : i; // everything finished: stay at the end, not back at the top
      for (let k = maxRows; k >= 1; k--) {
        start = Math.min(Math.max(0, next - (k > 1 ? 1 : 0)), rows.length - k);
        end = start + k;
        if (k + (start > 0 ? 1 : 0) + (end < rows.length ? 1 : 0) <= maxRows) break;
      }
    }
    const spare = maxRows - (end - start);
    const more = end < rows.length && spare > 0;
    const above = start > 0 && spare - (more ? 1 : 0) > 0;
    const shown = rows.slice(start, end);
    const plain = (l: string): string => ascii(l).slice(0, columns);
    const room = Math.max(0, columns - (this.fancy ? 4 : 7)); // indent, mark, space
    // A label keeps to 40 columns, fewer when the row needs the rest for its count, clock and the end of its path.
    const width = Math.min(Math.max(...shown.map((r) => r.label.length), 1), 40, Math.max(room - 25, 8));
    const lines = [
      plain(`${this.header()}  ${clock(Date.now() - this.start)}`),
      "",
      ...(above ? [plain(`  +${start} above`)] : []),
      ...shown.map((r) => this.compose(r, ascii(this.text(r, width, room)).slice(0, room))),
      ...(more ? [plain(`  +${rows.length - end} more`)] : []),
      "",
      plain(this.footer()),
    ];
    this.clearFrame();
    this.out.write(`${lines.join("\n")}\n`);
    this.frameLines = lines.length;
    this.drawn = true;
    this.tick += 1;
  }

  private clearFrame(): void {
    if (this.waiting) {
      this.out.write("\r\x1b[2K");
      this.waiting = false;
    }
    if (this.frameLines === 0) return;
    const stream = this.out as unknown as NodeJS.WritableStream;
    moveCursor(stream, 0, -this.frameLines);
    clearScreenDown(stream);
    this.frameLines = 0;
  }
}
