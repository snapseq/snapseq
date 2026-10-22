// Live terminal view of a run: a waiting line while the dev server comes up,
// then one line per sequence and device with a spinner and the shot count, then
// a frozen summary with errors and the run directory. Zero dependencies.
// Playwright owns exit codes and Ctrl-C; this only draws.
import { relative, resolve } from "node:path";
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
import { openInFileManager, openRun } from "./open.js";
import { canonical, configDirOf, rowLabel, sequenceId } from "./sequence-id.js";

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
  running: "..",
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
  running: "..",
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
/** The footer's statuses in order, the orchestration's `reused` among them; one with no count is left out. */
export const ORDER = ["passed", "reused", "failed", "timedOut", "interrupted", "skipped", "not run"];
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
/** A Playwright error as text: its message, else its value. The orchestration's result reporter reads errors with it too. */
export const errorText = (e: TestError): string => e.message ?? e.value ?? "unknown error";
/** Why a test was skipped: the description of its first skip or fixme annotation, the result's before the test's. */
export const skipReason = (test: TestCase, result: TestResult): string | undefined =>
  [...result.annotations, ...test.annotations].find((a) => a.type === "skip" || a.type === "fixme")?.description;
// Error text carries what a page or a sequence put in a message: keep the lines and the colors, drop what moves the
// cursor, retitles the terminal or reorders the text (other control and format characters). A tab is a space.
const printable = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*m|[\p{Cc}\p{Cf}]/gu, (m) => (m === "\t" ? " " : m === "\n" || m.length > 1 ? m : ""));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
export const shotCount = (n: number): string => `${n} shot${n === 1 ? "" : "s"}`;
const span = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : seconds(ms));
// Appears once as the error and once more in whatever call the deadline interrupted; may be wrapped in red.
const TIMEOUT_MSG = /(?:\x1b\[[0-9;]*m)*Test timeout of [\d.]+ms exceeded\./g;

/** Braille and one-column marks where the terminal can draw them; words in a four-column slot elsewhere. */
export const marks = (out: { isTTY?: boolean }): boolean =>
  !!out.isTTY && process.env.TERM !== "linux" && (process.platform !== "win32" || !!process.env.WT_SESSION);

/**
 * A row without colour: the indent, the mark in its slot (one column where marks are drawn, four for words), the label
 * padded to `width`, two spaces, the detail; after the mark, at most `room` characters. The orchestration parent writes
 * its own rows with it, so they line up with a child's.
 */
export const formatRow = (fancy: boolean, mark: string, label: string, width: number, detail: string, room = Infinity): string =>
  `  ${mark.padEnd(fancy ? 1 : 4)} ${`${label.padEnd(width)}  ${detail}`.slice(0, room)}`;

/** `nested/pricing / desktop`, the same identity the screenshots directory uses; ` (uat)` after it when `env` is given. */
function labelOf(test: TestCase, env?: string): string {
  const project = test.parent.project();
  // titlePath: root, project, file, then the titles.
  return rowLabel(project ? sequenceId(project.testDir, test.location.file, test.titlePath().slice(3)) : test.location.file, project?.name ?? "", env);
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
    this.fancy = marks(this.out);
    this.color = this.fancy && !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0";
    // A resize invalidates the cursor arithmetic; print events from then on.
    // The last frame stays as it was, its errors clipped to a line, so what it
    // held is printed in full once, as events would have.
    this.out.on?.("resize", () => {
      if (!this.live) return;
      this.live = false;
      this.frameLines = 0; // the frame stays; only the waiting line is cleared, so the header does not land on it
      this.clearFrame();
      for (const row of this.rows.values()) if (row.state !== "queued" && row.state !== "running") this.event(row);
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
      // Playwright reports files through resolved symlinks (macOS /var → /private/var); compare like with like.
      this.runDirAbsolute = resolve(canonical(configDirOf(config)), this.meta.screenshotsDir, this.meta.run);
      this.runDir = relative(canonical(process.cwd()), this.runDirAbsolute);
    }
    for (const test of suite.allTests()) this.row(test);
    this.begun = true;
    if (this.live) this.render();
    else if (!this.meta?.orchestration) this.out.write(`${this.header()}\n`);
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
    this.render();
  }

  // Each shot is a step named after its file; count the ones that completed.
  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "test.step" || !SHOT.test(step.title) || step.error) return;
    this.row(test).shots += 1;
    this.render();
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
    if (result.status === "skipped") row.note = skipReason(test, result);
    this.event(row);
  }

  // A frame hides errors until the summary; event mode prints them as they come.
  onError(error: TestError): void {
    if (this.live) this.globalErrors.push(printable(errorText(error)));
    else this.out.write(`${printable(errorText(error))}\n`);
  }

  onStdOut(chunk: string | Buffer): void {
    if (this.quiet) return;
    const text = String(chunk);
    this.clearFrame();
    this.out.write(text);
    this.partialLine = !text.endsWith("\n");
    this.render();
  }

  onStdErr(chunk: string | Buffer): void {
    this.onStdOut(chunk);
  }

  onEnd(result: FullResult): void {
    clearInterval(this.timer);
    for (const row of this.rows.values()) if (row.state === "queued") row.state = "not run";
    const hadFrame = this.live;
    this.clearFrame();
    this.live = false;

    // In an orchestration run the parent prints the heading, the footer and opens the folder; the rows stack under it.
    const orchestration = !!this.meta?.orchestration;
    const lines: string[] = orchestration ? [] : [""];
    // The frame is gone; print every row that ran once. Event mode already printed them.
    // Rows that never ran are the footer's count: after a stop at the first
    // failure they would bury the failure under pages of "not run".
    if (hadFrame) {
      const rows = [...this.rows.values()].filter((r) => r.state !== "not run");
      const width = Math.max(...rows.map((r) => r.label.length), this.minWidth());
      lines.push(...rows.map((r) => this.line(r, width)));
    }
    if (this.globalErrors.length > 0) lines.push("", ...this.globalErrors);
    if (!orchestration) lines.push("", this.footer(), "");
    if (lines.length > 0) this.out.write(`${lines.join("\n")}\n`);
    // Not after Ctrl-C: that leaves a directory nobody wants to look at. openRun checks CI here too, not only where the
    // reporter is chosen: a config or --reporter can name this one anywhere.
    if (!orchestration && result.status !== "interrupted" && this.runDirAbsolute) openRun({ isTTY: this.terminal }, this.runDirAbsolute, this.open);
  }

  private row(test: TestCase): Row {
    let row = this.rows.get(test.id);
    if (!row) {
      const orchestration = this.meta?.orchestration;
      row = { label: labelOf(test, orchestration?.showEnv ? this.meta?.env : undefined), state: "queued", shots: 0, duration: 0 };
      this.rows.set(test.id, row);
    }
    return row;
  }

  private event(row: Row): void {
    if (this.live) this.render();
    else this.out.write(`${this.line(row, Math.max(row.label.length, this.minWidth()))}\n`);
  }

  /** The label column's least width: the orchestration parent's, so its children's rows line up. */
  private minWidth(): number {
    return this.meta?.orchestration?.labelWidth ?? 0;
  }

  private header(): string {
    const m = this.meta;
    const parts = ["snapseq", m?.env, m?.host, m?.run].filter(Boolean);
    return `  ${parts.join("  ")}`;
  }

  private footer(): string {
    const rows = [...this.rows.values()];
    const counts = ORDER.map((s) => [rows.filter((r) => r.state === s).length, s] as const)
      .filter(([n]) => n > 0)
      .map(([n, s]) => `${n} ${s}`);
    const done = rows.filter((r) => r.state !== "queued" && r.state !== "running").length;
    const shots = rows.reduce((n, r) => n + r.shots, 0);
    const head = counts.length > 0 ? counts.join(", ") : `${done}/${rows.length} done`;
    const tail = this.runDir || clock(Date.now() - this.start);
    return `  ${head}  ${shotCount(shots)}  ${tail}`;
  }

  private spinner(): string {
    const frames = this.fancy ? FANCY_SPINNER : SPINNER;
    return frames[this.tick % frames.length]!;
  }

  /** A row: its mark colored, or the whole row dimmed, where the terminal takes it. With `room`, a frame's: one terminal line. */
  private compose(row: Row, width: number, room?: number): string {
    const glyph = row.state === "running" && this.live ? this.spinner() : (this.fancy ? FANCY_GLYPH : GLYPH)[row.state];
    const code = this.color && !DIM.has(row.state) ? COLOR[row.state] : undefined;
    // Colored once padded, so the codes take no column of the slot.
    const mark = code ? `\x1b[${code}m${glyph.padEnd(this.fancy ? 1 : 4)}\x1b[39m` : glyph;
    const label = room === undefined ? row.label : ascii(left(row.label, width));
    const line = formatRow(this.fancy, mark, label, width, this.detail(row, width, room), room);
    return this.color && DIM.has(row.state) ? `\x1b[2m${line}\x1b[22m` : line;
  }

  /** A row as events and the summary print it: the line, then the error in full. */
  private line(row: Row, width: number): string {
    // A running row has no error of its own; after a refused retry it would be the last attempt's.
    const error = row.error && row.state !== "running" ? printable(row.error).trimEnd().split("\n").map((l) => `\n         ${l}`).join("") : "";
    return this.compose(row, width) + error;
  }

  /** What follows a row's label: its count and time, where it is or died, and why. */
  private detail(row: Row, width: number, room = Infinity): string {
    let detail: string;
    const where = (): string => `  ${left(ascii(row.at ?? ""), room - width - detail.length - 4)}`;
    if (row.state === "running") {
      detail = shotCount(row.shots);
      // A slow page shows before it finishes. Events print once, so no clock there.
      if (this.live && row.started !== undefined) detail += `  ${clock(Date.now() - row.started)}`;
      if (row.at) detail += where();
    } else if (DIM.has(row.state)) {
      detail = row.note ? `${row.state}  ${ascii(row.note)}` : row.state;
    } else {
      detail = `${shotCount(row.shots)}  ${seconds(row.duration)}`;
      // Where it died, then why.
      if (row.error && row.at) detail += where();
      if (row.error) detail += `  ${ascii(row.error.split("\n")[0] ?? "")}`;
    }
    return detail;
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
      const mark = this.color ? `\x1b[${COLOR.running}m${this.spinner()}\x1b[39m` : this.spinner();
      this.out.write(`\r\x1b[2K  ${mark} ${ascii(text).slice(0, Math.max(0, columns - 4))}`);
      this.waiting = true;
      this.tick += 1;
      return;
    }
    const maxRows = Math.max(1, (this.out.rows ?? 24) - (MIN_ROWS - 1)); // all but the rows: header, two blanks, footer, prompt, a spare line
    // A todo list: rows stay in the order the run takes them and change in
    // place. When it does not fit it scrolls: the row to run is always in view,
    // the last finished row above it and queued rows below as far as there is
    // room. A `+N above` and a `+N more` line take a row each; only the running
    // row beats them, `above` giving way first.
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
    const width = Math.min(Math.max(...shown.map((r) => r.label.length), this.minWidth()), 40, Math.max(room - 25, 8));
    const orchestration = !!this.meta?.orchestration;
    const lines = [
      ...(orchestration ? [] : [plain(`${this.header()}  ${clock(Date.now() - this.start)}`), ""]),
      ...(above ? [plain(`  +${start} above`)] : []),
      // The detail is plain already: what it quotes went through ascii().
      ...shown.map((r) => this.compose(r, width, room)),
      ...(more ? [plain(`  +${rows.length - end} more`)] : []),
      ...(orchestration ? [] : ["", plain(this.footer())]),
    ];
    this.clearFrame();
    this.out.write(`${lines.join("\n")}\n`);
    this.frameLines = lines.length;
    this.tick += 1;
  }

  private clearFrame(): void {
    if (this.waiting) this.out.write("\r\x1b[2K");
    if (this.frameLines > 0) this.out.write(`\x1b[${this.frameLines}A\x1b[0J`);
    this.waiting = false;
    this.frameLines = 0;
  }
}
