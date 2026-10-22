import type { FullResult, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultReporter from "../orchestration/result-reporter.js";

// The pipe as a kernel may take it: three bytes a write at most.
const pipe = vi.hoisted(() => ({ written: [] as { fd: number; bytes: string }[] }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: (fd: number, data: Buffer) => {
    const bytes = data.subarray(0, 3);
    pipe.written.push({ fd, bytes: bytes.toString() });
    return bytes.length;
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  pipe.written.length = 0;
});

const test = (id: string, device: string): TestCase =>
  ({ id, parent: { project: () => ({ name: device }) }, annotations: [] }) as unknown as TestCase;

const capture = { sequence: "home", device: "desktop", shots: [] };
const attachment = (body: string) => ({ name: "snapseq-capture", contentType: "application/json", body: Buffer.from(body) });

const result = (status: TestResult["status"], over: Partial<TestResult> = {}): TestResult =>
  ({ status, annotations: [], errors: [], attachments: [], ...over }) as unknown as TestResult;

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
    const empty = { status: "not run", skipReason: null, error: null, capture: null };
    expect(doc("failed")).toEqual({ status: "failed", errors: [], tests: [{ device: "desktop", ...empty }, { device: "mobile", ...empty }] });
  });

  it("carries a passed test's capture, a skip's reason, a failure's first error and every run error", () => {
    const [a, b, c] = [test("a", "desktop"), test("b", "mobile"), test("c", "tablet")];
    const { r, doc } = run([a, b, c]);
    r.onTestEnd(a, result("passed", { attachments: [attachment(JSON.stringify(capture))] }));
    r.onTestEnd(b, result("skipped", { annotations: [{ type: "skip", description: "desktop only" }] }));
    r.onTestEnd(c, result("failed", { errors: [{ message: "boom" }, { message: "later" }] }));
    r.onError({ message: "global" });
    r.onError({ value: "thrown value" });
    expect(doc()).toEqual({
      status: "passed",
      errors: ["global", "thrown value"],
      tests: [
        { device: "desktop", status: "passed", skipReason: null, error: null, capture },
        { device: "mobile", status: "skipped", skipReason: "desktop only", error: null, capture: null },
        { device: "tablet", status: "failed", skipReason: null, error: "boom", capture: null },
      ],
    });
  });

  it("gives a passed test with no capture attachment no capture and no error, and one with two or a broken one an error saying which", () => {
    const tests = [test("a", "desktop"), test("b", "desktop"), test("c", "desktop")];
    const { r, doc } = run(tests);
    r.onTestEnd(tests[0]!, result("passed"));
    r.onTestEnd(tests[1]!, result("passed", { attachments: [attachment("{}"), attachment("{}")] }));
    r.onTestEnd(tests[2]!, result("passed", { attachments: [attachment("{not json")] }));
    const entries = doc().tests as { device: string; capture: unknown; error: string | null }[];
    expect(entries.map((e) => e.device)).toEqual(["desktop", "desktop", "desktop"]); // one entry per test, two on one device included
    expect(entries.map((e) => e.capture)).toEqual([null, null, null]);
    expect(entries[0]!.error).toBeNull(); // the sequence never used seq
    expect(entries[1]!.error).toBe("snapseq: 2 snapseq-capture attachments on a passed test, expected one");
    expect(entries[2]!.error).toMatch(/^snapseq: the snapseq-capture attachment is not JSON: /);
  });

  it("writes the whole document to fd 3, the parent's pipe, however little each write takes", () => {
    new ResultReporter().onEnd({ status: "passed" } as FullResult);
    expect(new Set(pipe.written.map((w) => w.fd))).toEqual(new Set([3]));
    expect(pipe.written.length).toBeGreaterThan(1);
    expect(JSON.parse(pipe.written.map((w) => w.bytes).join(""))).toEqual({ status: "passed", errors: [], tests: [] });
  });
});
