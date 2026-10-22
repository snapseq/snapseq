import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// An orchestration child as the parent spawns it: the BUILT package, a request file, the real Playwright CLI, fd 3 a pipe.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PW_CLI = join(PKG, "node_modules/@playwright/test/cli.js");

let server: ReturnType<typeof createServer>;
let host: string;
let app: string;

const SEQUENCES: Record<string, string> = {
  "campaign/pricing": `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/pricing");
  await seq.snap({ label: "Pricing", mask: [page.locator("h1")] });
});`,
  titled: `import { sequence } from "snapseq";
import { test } from "@playwright/test";
test.describe("hero", () => sequence(async ({ seq }) => void seq.dir));`,
  elsewhere: `import { sequence } from "snapseq";
import { test } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:1" });
sequence(async ({ seq }) => void seq.dir);`,
  dangling: `import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/pricing");
  void seq.snap();
});`,
};

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><h1>Pricing</h1>");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = realpathSync(mkdtempSync(join(tmpdir(), "snapseq-child-")));
  mkdirSync(join(app, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(PKG, join(app, "node_modules", "snapseq"));
  symlinkSync(join(PKG, "node_modules", "@playwright", "test"), join(app, "node_modules", "@playwright", "test"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(app, "snapseq.config.ts"),
    `import { defineConfig } from "snapseq";\nexport default defineConfig({ envs: { dev: { host: "${host}" } }, stabilize: false });\n`,
  );
  for (const [id, src] of Object.entries(SEQUENCES)) {
    mkdirSync(dirname(join(app, "snapseq", id)), { recursive: true });
    writeFileSync(join(app, "snapseq", `${id}.seq.ts`), src);
  }
});

afterAll(async () => {
  await new Promise((done) => (server.closeAllConnections(), server.close(done)));
  rmSync(app, { recursive: true, force: true });
});

/** One child for `sequence` on these devices; resolves to its exit code, its output and the document from fd 3. */
function child(sequence: string, devices: Record<string, object>, deviceOrder = Object.keys(devices)) {
  const request = join(app, "node_modules", ".cache", "snapseq", "requests", `${sequence.replace(/\//g, "-")}.json`);
  mkdirSync(dirname(request), { recursive: true });
  const file = join(app, "snapseq", `${sequence}.seq.ts`);
  const body = { version: 1, sequence, file, snapseq: { devices }, deviceOrder, playwright: [], terminal: { labelWidth: 0 } };
  writeFileSync(request, JSON.stringify(body));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SNAPSEQ_") && k !== "CI") env[k] = v;
  return new Promise<{ status: number | null; out: string; doc: { status: string; errors: string[]; tests: Record<string, unknown>[] } }>((ok) => {
    const proc = spawn(process.execPath, [PW_CLI, "test", "-c", join(app, "snapseq.config.ts")], {
      cwd: app,
      env: { ...env, SNAPSEQ_OVERRIDES_FILE: request, SNAPSEQ_RUN: "r1", SNAPSEQ_OPEN: "0" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = "";
    let doc = "";
    proc.stdout!.on("data", (d: Buffer) => (out += d));
    proc.stderr!.on("data", (d: Buffer) => (out += d));
    proc.stdio[3]!.on("data", (d: Buffer) => (doc += d));
    proc.on("close", (status) => ok({ status, out, doc: JSON.parse(doc) }));
  });
}

describe("an orchestration child", () => {
  it("shoots exactly the requested file on the requested devices, in order, and hands each capture back on fd 3", async () => {
    const r = await child("campaign/pricing", { b: { viewport: { width: 500, height: 400 } }, a: { viewport: { width: 400, height: 300 } } }, ["b", "a"]);
    expect(r.status, r.out).toBe(0);
    expect(r.doc.status).toBe("passed");
    expect(r.doc.errors).toEqual([]);
    const dir = (device: string) => join(app, "screenshots", "r1", "campaign", "pricing", device);
    const entry = (device: string) => ({
      device,
      status: "passed",
      retry: 0,
      usedSeq: true,
      skipReason: null,
      error: null,
      capture: {
        sequence: "campaign/pricing",
        device,
        env: "dev",
        host,
        dir: dir(device),
        shots: [
          {
            index: 1,
            name: "01.png",
            path: join(dir(device), "01.png"),
            url: `${host}/pricing`,
            notes: [],
            deviceScaleFactor: 1,
            format: { type: "png" },
            options: { label: "Pricing" }, // the mask left out
          },
        ],
      },
    });
    expect(r.doc.tests).toEqual([entry("b"), entry("a")]);
  });

  it("refuses a test whose id is not the one requested, before it wipes anything", async () => {
    const r = await child("titled", { d: {} });
    expect(r.status).toBe(1);
    expect(r.doc.tests).toEqual([
      expect.objectContaining({ status: "failed", usedSeq: true, capture: null, error: expect.stringContaining('snapseq: this file runs as "titled"; a describe title or a second test changes the id to "titled/hero/sequence"') }),
    ]);
  });

  it("refuses a context whose baseURL is not the run's host", async () => {
    const r = await child("elsewhere", { d: {} });
    expect(r.status).toBe(1);
    expect(r.doc.tests).toEqual([
      expect.objectContaining({ status: "failed", capture: null, error: expect.stringContaining(`snapseq: the context's baseURL "http://127.0.0.1:1" is not this run's host "${host}"`) }),
    ]);
  });

  it("fails a sequence that ended with a shot still being taken, and attaches no capture", async () => {
    const r = await child("dangling", { d: {} });
    expect(r.status).toBe(1);
    expect(r.doc.tests).toEqual([
      expect.objectContaining({ status: "failed", capture: null, error: expect.stringContaining("snapseq: a shot was still being taken when the sequence ended") }),
    ]);
  });
});
