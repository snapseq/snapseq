import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the BUILT bin (dist/cli.js) from a temp project, the way a consumer would.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// What /api answers; one test sets it, then runs a sequence that fetches it.
let api = { status: 200, type: "application/json", body: '{"v":"live"}' };
let server: ReturnType<typeof createServer>;
let host: string;
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api")) {
      let posted = "";
      req.on("data", (d: Buffer) => (posted += d)).on("end", () => {
        res.writeHead(api.status, { "content-type": api.type });
        res.end(req.method === "POST" ? JSON.stringify({ v: posted }) : api.body);
      });
      return;
    }
    if (req.url === "/blank") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><h1 id="v"></h1><script>fetch("/api").then((r) => r.json()).then((j) => { document.getElementById("v").textContent = j.v; });</script>`,
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => (server.closeAllConnections(), server.close(done)));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `dir` as a consumer's app: the package and its Playwright linked into node_modules, plus these files. */
function makeApp(dir: string, files: Record<string, string>): string {
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(PKG, join(dir, "node_modules", "snapseq"));
  symlinkSync(join(PKG, "node_modules", "@playwright", "test"), join(dir, "node_modules", "@playwright", "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  return dir;
}

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "snapseq-cli-"));
  dirs.push(dir);
  return dir;
};

// Async on purpose: the fixture server runs in this process.
function snapseq(cwd: string, args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SNAPSEQ_")) env[k] = v;
  }
  return new Promise<{ status: number | null; out: string }>((ok) => {
    const child = spawn(process.execPath, [join(PKG, "dist", "cli.js"), ...args], {
      cwd,
      env: { ...env, SNAPSEQ_RUN: "run1" },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => ok({ status, out }));
  });
}

const config = (extra = "") => `import { defineConfig } from "snapseq";
export default defineConfig({ envs: { dev: { host: ${JSON.stringify(host)}, ${extra} } }, devices: { d1: {} } });`;

const WIDGET = `
import { sequence } from "snapseq";
sequence(async ({ page, seq }) => {
  await page.goto("/");
  await page.locator("#v:not(:empty)").waitFor();
  await seq.snap();
});`;

describe("--record", () => {
  const record = (replayFile?: string, sequence = WIDGET) => {
    const dir = makeApp(tmp(), {
      "snapseq.config.ts": config(`replay: { "**/api": "snapseq/replay/api.json" }`),
      "snapseq/w.seq.ts": sequence,
    });
    const file = join(dir, "snapseq/replay/api.json");
    if (replayFile !== undefined) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, replayFile);
    }
    return { dir, file };
  };

  it("refuses a status that is not a 2xx before writing, and leaves the file it would have replaced", async () => {
    api = { status: 403, type: "application/json", body: '{"error":"bot check"}' };
    const { dir, file } = record('{"v":"old"}');
    const r = await snapseq(dir, ["--record"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`snapseq: --record got 403 for ${host}/api; snapseq/replay/api.json not written`);
    expect(readFileSync(file, "utf8")).toBe('{"v":"old"}');
    expect(existsSync(join(dir, "screenshots/run1/w/d1/01.png"))).toBe(false); // refused before any shot
  });

  it("refuses a body that is not JSON before writing", async () => {
    api = { status: 200, type: "text/html", body: "<html>blocked</html>" };
    const { dir, file } = record();
    const r = await snapseq(dir, ["--record"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`snapseq: --record got a non-JSON body for ${host}/api; snapseq/replay/api.json not written`);
    expect(existsSync(file)).toBe(false);
  });

  it("writes a 200 JSON body, as before", async () => {
    api = { status: 200, type: "application/json", body: '{"v":"live"}' };
    const { dir, file } = record();
    const r = await snapseq(dir, ["--record"]);
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: "live" });
  });

  it("records for =1 and =true, replays for =0 and =false, and refuses any other value", async () => {
    api = { status: 200, type: "application/json", body: '{"v":"live"}' };
    for (const value of ["0", "false"]) {
      const { dir, file } = record('{"v":"old"}');
      const r = await snapseq(dir, [`--record=${value}`]);
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(file, "utf8")).toBe('{"v":"old"}'); // replayed, not overwritten
    }
    for (const value of ["1", "true"]) {
      const { dir, file } = record('{"v":"old"}');
      const r = await snapseq(dir, [`--record=${value}`]);
      expect(r.status, r.out).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: "live" });
    }
    for (const value of ["yes", ""]) {
      const { dir } = record('{"v":"old"}');
      const r = await snapseq(dir, [`--record=${value}`]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain(`must be 1 or 0, got "${value}"`); // SNAPSEQ_RECORD's check, or the flag's for "".
    }
  });

  it("refuses a second request that the same pattern matches, before it overwrites the file", async () => {
    api = { status: 200, type: "application/json", body: '{"v":"live"}' };
    // The same server under another host name: what a third-party request matching the glob looks like.
    const { dir, file } = record(
      undefined,
      `
import { sequence } from "snapseq";
sequence(async ({ page, host }) => {
  await page.goto("/");
  await page.locator("#v:not(:empty)").waitFor();
  await page.evaluate((u) => fetch(u).catch(() => undefined), host.replace("127.0.0.1", "localhost") + "/api");
});`,
    );
    const r = await snapseq(dir, ["--record"]);
    expect(r.status).not.toBe(0);
    const other = host.replace("127.0.0.1", "localhost");
    expect(r.out).toContain(
      `snapseq: --record: **/api matched a second request GET ${other}/api; snapseq/replay/api.json already written from GET ${host}/api`,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: "live" }); // the first one's
  });

  it("refuses a second POST to the same URL with another body, and keeps the first's response", async () => {
    const { dir, file } = record(
      undefined,
      `
import { sequence } from "snapseq";
sequence(async ({ page }) => {
  await page.goto("/blank");
  await page.evaluate(async () => {
    await fetch("/api", { method: "POST", body: "lamps" });
    await fetch("/api", { method: "POST", body: "chairs" }).catch(() => undefined);
  });
});`,
    );
    const r = await snapseq(dir, ["--record"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(
      `snapseq: --record: **/api matched a second request POST ${host}/api; snapseq/replay/api.json already written from POST ${host}/api`,
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: "lamps" }); // not overwritten by "chairs"
  });

  it("treats a FormData POST sent twice as one request, whatever its boundary, and says when the bodies differ", async () => {
    const sendTwice = (first: string, second: string) =>
      record(
        undefined,
        `
import { sequence } from "snapseq";
sequence(async ({ page }) => {
  await page.goto("/blank");
  await page.evaluate(async (values) => {
    for (const q of values) {
      const form = new FormData();
      form.append("q", q);
      await fetch("/api", { method: "POST", body: form }).catch(() => undefined);
    }
  }, ${JSON.stringify([first, second])});
});`,
      );
    const same = sendTwice("lamps", "lamps");
    const r = await snapseq(same.dir, ["--record"]);
    expect(r.status, r.out).toBe(0); // each send has its own random boundary
    expect(JSON.parse(readFileSync(same.file, "utf8")).v).toContain("lamps");

    const other = sendTwice("lamps", "chairs");
    const d = await snapseq(other.dir, ["--record"]);
    expect(d.status).not.toBe(0);
    expect(d.out).toContain(
      `snapseq: --record: **/api matched a second request POST ${host}/api; snapseq/replay/api.json already written from POST ${host}/api (the bodies differ)`,
    );
    expect(JSON.parse(readFileSync(other.file, "utf8")).v).toContain("lamps"); // not overwritten by "chairs"
  });

  it("normalizes only the boundary's delimiter lines, and reads the boundary parameter exactly", async () => {
    const form = (boundary: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="q"\r\n\r\n${value}\r\n--${boundary}--\r\n`;
    const send = (sends: Array<{ type: string; body: string }>) =>
      record(
        undefined,
        `
import { sequence } from "snapseq";
sequence(async ({ page }) => {
  await page.goto("/blank");
  await page.evaluate(async (sends) => {
    for (const { type, body } of sends) {
      await fetch("/api", { method: "POST", headers: { "content-type": type }, body }).catch(() => undefined);
    }
  }, ${JSON.stringify(sends)});
});`,
      );
    const mp = (params: string) => `multipart/form-data; ${params}`;
    const refused = `snapseq: --record: **/api matched a second request POST ${host}/api; snapseq/replay/api.json already written from POST ${host}/api (the bodies differ)`;
    const cases: Array<[string, Array<{ type: string; body: string }>, boolean]> = [
      // A field value that holds the boundary is not a delimiter: these differ, though a global replace would make them equal.
      ["a value holding the boundary", [
        { type: mp("boundary=Alpha"), body: form("Alpha", "value-Alpha") },
        { type: mp("boundary=Beta"), body: form("Beta", "value-Beta") },
      ], true],
      ["the same body under two boundaries", [
        { type: mp("boundary=Alpha"), body: form("Alpha", "v") },
        { type: mp("boundary=Beta"), body: form("Beta", "v") },
      ], false],
      ["a boundary followed by a space and another parameter", [
        { type: mp("boundary=Alpha ; charset=utf-8"), body: form("Alpha", "v") },
        { type: mp("boundary=Beta ; charset=utf-8"), body: form("Beta", "v") },
      ], false],
      ["another parameter ending in boundary", [
        { type: mp("x-boundary=Ignored; boundary=Alpha"), body: form("Alpha", "v") },
        { type: mp("x-boundary=Ignored; boundary=Beta"), body: form("Beta", "v") },
      ], false],
      ["a media type that only starts with multipart/form-data", [
        { type: "multipart/form-data-extra; boundary=Alpha", body: form("Alpha", "v") },
        { type: "multipart/form-data-extra; boundary=Beta", body: form("Beta", "v") },
      ], true],
    ];
    for (const [name, sends, isRefused] of cases) {
      const { dir } = send(sends);
      const r = await snapseq(dir, ["--record"]);
      if (isRefused) {
        expect(r.status, name).not.toBe(0);
        expect(r.out, name).toContain(refused);
      } else {
        expect(r.status, `${name}: ${r.out}`).toBe(0);
      }
    }
  });
});

describe("replay", () => {
  it("fails before the sequence starts when a replay file is not JSON, naming the file and the parse error", async () => {
    const dir = makeApp(tmp(), {
      "snapseq.config.ts": config(`replay: { "**/api": "snapseq/replay/api.json" }`),
      "snapseq/w.seq.ts": WIDGET,
      "snapseq/replay/api.json": '{"v":"old"',
    });
    const r = await snapseq(dir, []);
    expect(r.status).not.toBe(0);
    let message = "";
    try {
      JSON.parse('{"v":"old"');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(r.out).toContain(`snapseq: replay file snapseq/replay/api.json is not JSON: ${message}`);
    expect(existsSync(join(dir, "screenshots/run1/w/d1/01.png"))).toBe(false); // refused before any shot
  });
});

describe("Playwright beside the config", () => {
  it("is the app's own, found from a monorepo root that has none", async () => {
    const root = tmp();
    makeApp(join(root, "apps/web"), {
      "snapseq.config.ts": config(),
      "snapseq/w.seq.ts": WIDGET,
    });
    const r = await snapseq(root, ["-c", "apps/web/snapseq.config.ts", "--list"]);
    expect(r.out).not.toContain("Cannot find module");
    expect(r.out).toContain("w.seq.ts");
    expect(r.status, r.out).toBe(0);
  });
});
