// The parent's own lines around the children's rows: heading, a line per part it did not shoot, the footer,
// the reshoot hint, the Finder open. The children draw everything else.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { openInFileManager } from "../open.js";
import { marks } from "../reporter.js";

export interface Out {
  isTTY?: boolean;
  write(s: string): unknown;
}

const ORDER = ["passed", "reused", "failed", "timedOut", "interrupted", "skipped", "not run"];

export const plural = (n: number): string => `${n} shot${n === 1 ? "" : "s"}`;

/** `2m 10s`, or `42s` under a minute. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export const heading = (out: Out, file: string, run: string): unknown =>
  out.write(`  snapseq  ${basename(file)}  ${run}\n\n`);

/** `= 12345-spring-launch / desktop  reused  12 shots`: a mark, then the label padded, as a child composes its rows. */
export const partLine = (out: Out, mark: string, label: string, width: number, text: string): unknown =>
  out.write(`  ${mark.padEnd(marks(out) ? 1 : 4)} ${label.padEnd(width)}  ${text}\n`);

export const failed = (out: Out, message: string): unknown => out.write(`\n  failed  ${message}\n`);

export const interrupted = (out: Out, runDir: string): unknown => out.write(`\n  interrupted  ${runDir}\n`);

/** `6 passed, 1 reused  72 shots  2m 10s  screenshots/review-1`. */
export function footer(out: Out, tally: Readonly<Record<string, number>>, shots: number, ms: number, runDir: string): void {
  const counts = ORDER.filter((s) => (tally[s] ?? 0) > 0).map((s) => `${tally[s]} ${s}`);
  out.write(`  ${counts.join(", ") || "nothing captured"}  ${plural(shots)}  ${duration(ms)}  ${runDir}\n`);
}

const quote = (s: string): string => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** After a full run, once: how to reshoot one part and rebuild the rest from the run's cache. */
export function hint(out: Out, file: string, config: string | undefined, run: string): void {
  const c = config === undefined ? "" : ` -c ${quote(config)}`;
  out.write(`  reshoot one part: snapseq ${quote(file)}${c} --run ${quote(run)} <sequence> --device <device>\n`);
}

/** Someone is watching: show them the run. Pipes and CI never get a window; SNAPSEQ_OPEN=0 (or false) keeps it closed. */
export function openRun(out: Out, dir: string): void {
  if (out.isTTY && !process.env.CI && !/^(0|false)$/i.test(process.env.SNAPSEQ_OPEN ?? "") && existsSync(dir)) {
    openInFileManager(dir);
  }
}
