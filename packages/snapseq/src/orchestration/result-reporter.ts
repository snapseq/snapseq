// The child's answer to the orchestration parent: one JSON document on fd 3 at the end of the run, and nothing else.
// defineConfig appends it last in an orchestration run; it prints nothing, so the terminal stays the other reporters'.
import { writeSync } from "node:fs";
import type { FullResult, Reporter, Suite, TestCase, TestError, TestResult } from "@playwright/test/reporter";

interface Entry {
  device: string;
  status: TestResult["status"] | "not run";
  retry: number;
  /** The retries the test was given, `test.describe.configure({ retries })` included: a pass at attempt 0 does not show them. */
  retries: number;
  usedSeq: boolean;
  skipReason: string | null;
  error: string | null;
  capture: unknown;
}

const message = (error: TestError | undefined): string | null => error?.message ?? error?.value ?? null;

// The pipe the parent opened, named by SNAPSEQ_RESULT_FD; an ordinary run sets none, and gets nothing, whatever fd 3 it inherited.
function toParent(text: string): void {
  const fd = Number(process.env.SNAPSEQ_RESULT_FD);
  if (!Number.isInteger(fd) || fd < 3) return;
  for (let rest = Buffer.from(text); rest.length > 0; ) rest = rest.subarray(writeSync(fd, rest));
}

export default class ResultReporter implements Reporter {
  private readonly write: (text: string) => void;
  private readonly tests = new Map<string, Entry>();
  private readonly errors: string[] = [];

  /** Playwright passes its reporter options; tests pass `write`. */
  constructor(options: { write?: (text: string) => void } = {}) {
    this.write = options.write ?? toParent;
  }

  printsToStdio(): boolean {
    return false;
  }

  // Every test planned, so one that a stop at the first failure never started still answers, as not run.
  onBegin(_config: unknown, suite: Suite): void {
    for (const test of suite.allTests()) {
      const device = test.parent.project()?.name ?? "";
      this.tests.set(test.id, { device, status: "not run", retry: 0, retries: test.retries, usedSeq: false, skipReason: null, error: null, capture: null });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const entry = this.tests.get(test.id);
    if (!entry) return;
    const annotations = [...result.annotations, ...test.annotations];
    entry.status = result.status;
    entry.retry = result.retry;
    entry.usedSeq = annotations.some((a) => a.type === "snapseq" && a.description === "usedSeq");
    entry.skipReason = annotations.find((a) => a.type === "skip" || a.type === "fixme")?.description ?? null;
    entry.error = message(result.errors[0]);
    entry.capture = null;
    if (result.status !== "passed") return;
    const attached = result.attachments.filter((a) => a.name === "snapseq-capture");
    if (attached.length !== 1) {
      entry.error = `snapseq: ${attached.length === 0 ? "no" : attached.length} snapseq-capture attachments on a passed test, expected one`;
      return;
    }
    try {
      entry.capture = JSON.parse(String(attached[0]!.body));
    } catch (cause) {
      entry.error = `snapseq: the snapseq-capture attachment is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  onError(error: TestError): void {
    this.errors.push(message(error) ?? "unknown error");
  }

  onEnd(result: FullResult): void {
    this.write(JSON.stringify({ version: 1, status: result.status, errors: this.errors, tests: [...this.tests.values()] }));
  }
}
