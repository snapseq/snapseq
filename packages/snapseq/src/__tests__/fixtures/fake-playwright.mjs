// Stands in for `playwright test` in the orchestration tests. Reads the request the parent wrote, logs what it
// was given to calls.jsonl beside the config, does what scenario.json there says for this sequence, writes the
// result document to fd 3, as the result reporter does, and exits.
//
// scenario.json: { "<sequence>": { exit, report: "none" | "garbage", status, errors, tests,
//   devices: { "<device>": { status, skipReason, error, capture: false | "wrong-dir" | "missing-file" } },
//   hang: true (wait for a signal), ignoreInt: true } }
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(process.argv[process.argv.indexOf("-c") + 1]);
const requestFile = process.env.SNAPSEQ_REQUEST_FILE;
const request = JSON.parse(readFileSync(requestFile, "utf8"));
const cacheFile = join(root, "node_modules/.cache/snapseq/runs", `${process.env.SNAPSEQ_RUN}.json`);
const env = Object.fromEntries(
  ["SNAPSEQ_ENV", "SNAPSEQ_HOST", "SNAPSEQ_RUN", "SNAPSEQ_OPEN", "SNAPSEQ_RECORD"].map((k) => [k, process.env[k] ?? null]),
);
appendFileSync(
  join(root, "calls.jsonl"),
  `${JSON.stringify({
    argv: process.argv.slice(2),
    requestFile,
    request,
    env,
    cacheAtStart: existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : null,
  })}\n`,
);
const scenarios = existsSync(join(root, "scenario.json")) ? JSON.parse(readFileSync(join(root, "scenario.json"), "utf8")) : {};
const s = scenarios[request.sequence] ?? {};

if (s.hang) {
  process.on("SIGINT", () => s.ignoreInt || process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
  writeFileSync(join(root, "started"), String(process.pid));
} else {
  const shotEnv = process.env.SNAPSEQ_ENV || "dev";
  const host = process.env.SNAPSEQ_HOST || `https://${shotEnv}.example`;
  const tests = [];
  for (const [device] of request.devices) {
    const { capture: kind, ...d } = { status: "passed", skipReason: null, error: null, ...s.devices?.[device] };
    for (let n = 0; n < (s.tests ?? 1); n++) {
      let capture = null;
      if (d.status === "passed" && kind !== false) {
        const dir = join(root, request.snapseq.screenshotsDir ?? "screenshots", process.env.SNAPSEQ_RUN, request.sequence, device);
        mkdirSync(dir, { recursive: true });
        const shots = [1, 2].map((index) => {
          const name = `0${index}.png`;
          writeFileSync(join(dir, name), "png");
          return { index, name, path: join(dir, name), url: `${host}/`, notes: [], deviceScaleFactor: 1, format: { type: "png" }, options: {} };
        });
        if (kind === "missing-file") rmSync(shots[1].path);
        capture = { sequence: request.sequence, device, env: shotEnv, host, dir: kind === "wrong-dir" ? join(root, "elsewhere") : dir, shots };
      }
      tests.push({ ...d, device, capture });
    }
  }
  const bad = tests.some((t) => t.status !== "passed") || (s.errors ?? []).length > 0;
  const doc = JSON.stringify({ status: s.status ?? (bad ? "failed" : "passed"), errors: s.errors ?? [], tests });
  if (s.report === "garbage") writeSync(3, "{not json");
  else if (s.report !== "none") writeSync(3, doc);
  process.exit(s.exit ?? (bad ? 1 : 0));
}
