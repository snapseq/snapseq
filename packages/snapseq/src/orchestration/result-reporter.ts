// The child's answer to the orchestration parent: one JSON document on fd 3 at the end of the run, and nothing else.
// defineConfig appends it last in an orchestration run; it prints nothing, so the terminal stays the other reporters'.
import { writeSync } from "node:fs";
import type { FullResult, Reporter, Suite, TestCase, TestError, TestResult } from "@playwright/test/reporter";
import { errorText, skipReason } from "../reporter.js";

export interface Entry {
  device: string;
  status: TestResult["status"] | "not run";
  skipReason: string | null;
  error: string | null;
  capture: unknown;
}

export interface Report {
  status: FullResult["status"];
  errors: string[];
  tests: Entry[];
}

// fd 3: the pipe the parent opened (spawn.ts). Only a request adds this reporter, and only the parent writes one.
function toParent(text: string): void {
  for (let rest = Buffer.from(text); rest.length > 0; ) rest = rest.subarray(writeSync(3, rest));
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
      this.tests.set(test.id, { device, status: "not run", skipReason: null, error: null, capture: null });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const entry = this.tests.get(test.id);
    if (!entry) return;
    entry.status = result.status;
    entry.skipReason = skipReason(test, result) ?? null;
    entry.error = result.errors[0] ? errorText(result.errors[0]) : null;
    entry.capture = null;
    if (result.status !== "passed") return;
    const attached = result.attachments.filter((a) => a.name === "snapseq-capture");
    // None: the sequence never used `seq`, as the fixture attaches one whenever it did and the test passed.
    if (attached.length === 0) return;
    if (attached.length > 1) {
      entry.error = `snapseq: ${attached.length} snapseq-capture attachments on a passed test, expected one`;
      return;
    }
    try {
      entry.capture = JSON.parse(String(attached[0]!.body));
    } catch (cause) {
      entry.error = `snapseq: the snapseq-capture attachment is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  onError(error: TestError): void {
    this.errors.push(errorText(error));
  }

  onEnd(result: FullResult): void {
    this.write(JSON.stringify({ status: result.status, errors: this.errors, tests: [...this.tests.values()] } satisfies Report));
  }
}
