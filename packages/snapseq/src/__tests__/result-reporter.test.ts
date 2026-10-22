import type { FullResult, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { describe, expect, it } from "vitest";
import ResultReporter from "../orchestration/result-reporter.js";

const test = (id: string, device: string): TestCase =>
  ({ id, parent: { project: () => ({ name: device }) }, annotations: [] }) as unknown as TestCase;

const USED = { type: "snapseq", description: "usedSeq" };
const capture = { sequence: "home", device: "desktop", shots: [] };
const attachment = (body: string) => ({ name: "snapseq-capture", contentType: "application/json", body: Buffer.from(body) });

const result = (status: TestResult["status"], over: Partial<TestResult> = {}): TestResult =>
  ({ status, retry: 0, annotations: [], errors: [], attachments: [], ...over }) as unknown as TestResult;

/** A reporter over these tests; `doc()` ends the run and returns what went to the parent. */
function run(tests: TestCase[]) {
  const written: string[] = [];
  const r = new ResultReporter({ write: (text) => written.push(text) });
  r.onBegin({}, { allTests: () => tests } as unknown as Suite);
  const doc = (status: FullResult["status"] = "passed") => {
    r.onEnd({ status } as FullResult);
    expect(written).toHaveLength(1);
    return JSON.parse(written[0]!);
  };
  return { r, doc };
}

describe("ResultReporter", () => {
  it("answers for every planned test, as not run until it ends, and prints nothing", () => {
    const { r, doc } = run([test("a", "desktop"), test("b", "mobile")]);
    expect(r.printsToStdio()).toBe(false);
    const empty = { status: "not run", retry: 0, usedSeq: false, skipReason: null, error: null, capture: null };
    expect(doc("failed")).toEqual({ version: 1, status: "failed", errors: [], tests: [{ device: "desktop", ...empty }, { device: "mobile", ...empty }] });
  });

  it("carries a passed test's capture, a skip's reason, a failure's first error and every run error", () => {
    const [a, b, c] = [test("a", "desktop"), test("b", "mobile"), test("c", "tablet")];
    const { r, doc } = run([a, b, c]);
    r.onTestEnd(a, result("passed", { annotations: [USED], attachments: [attachment(JSON.stringify(capture))] }));
    r.onTestEnd(b, result("skipped", { annotations: [{ type: "skip", description: "desktop only" }] }));
    r.onTestEnd(c, result("failed", { retry: 1, annotations: [USED], errors: [{ message: "boom" }, { message: "later" }] }));
    r.onError({ message: "global" });
    r.onError({ value: "thrown value" });
    expect(doc()).toEqual({
      version: 1,
      status: "passed",
      errors: ["global", "thrown value"],
      tests: [
        { device: "desktop", status: "passed", retry: 0, usedSeq: true, skipReason: null, error: null, capture },
        { device: "mobile", status: "skipped", retry: 0, usedSeq: false, skipReason: "desktop only", error: null, capture: null },
        { device: "tablet", status: "failed", retry: 1, usedSeq: true, skipReason: null, error: "boom", capture: null },
      ],
    });
  });

  it("gives a passed test with no, two or a broken capture attachment no capture and an error saying which", () => {
    const tests = [test("a", "desktop"), test("b", "desktop"), test("c", "desktop")];
    const { r, doc } = run(tests);
    r.onTestEnd(tests[0]!, result("passed", { annotations: [USED] }));
    r.onTestEnd(tests[1]!, result("passed", { annotations: [USED], attachments: [attachment("{}"), attachment("{}")] }));
    r.onTestEnd(tests[2]!, result("passed", { annotations: [USED], attachments: [attachment("{not json")] }));
    const entries = doc().tests as { device: string; capture: unknown; error: string }[];
    expect(entries.map((e) => e.device)).toEqual(["desktop", "desktop", "desktop"]); // one entry per test, two on one device included
    expect(entries.map((e) => e.capture)).toEqual([null, null, null]);
    expect(entries[0]!.error).toBe("snapseq: no snapseq-capture attachments on a passed test, expected one");
    expect(entries[1]!.error).toBe("snapseq: 2 snapseq-capture attachments on a passed test, expected one");
    expect(entries[2]!.error).toMatch(/^snapseq: the snapseq-capture attachment is not JSON: /);
  });
});
