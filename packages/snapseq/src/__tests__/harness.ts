import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// What the tests that drive the BUILT package through a real Playwright share, the way a consumer would.
export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PW_CLI = join(PKG, "node_modules/@playwright/test/cli.js");

export const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** `server` listening on a free local port: its URL, the `hits` log its handler fills, and a close that drops open connections. */
export function listen<T>(server: Server, hits: T[]) {
  return new Promise<{ url: string; hits: T[]; close: () => Promise<void> }>((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))),
      });
    });
  });
}

/** The notes the run printed, one line per shot taken with any: `snapseq: 01.png taken with <notes>  <url>`. */
export const notes = (out: string) => out.match(/snapseq: \d+\.png taken with .*/g) ?? [];

/** `dir` as a consumer's app: the package and its Playwright linked into node_modules, plus these files. */
export function makeApp(dir: string, files: Record<string, string>): string {
  mkdirSync(join(dir, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(PKG, join(dir, "node_modules", "snapseq"));
  // The consumer's own Playwright; same realpath as the package's, so one runner instance.
  symlinkSync(join(PKG, "node_modules", "@playwright", "test"), join(dir, "node_modules", "@playwright", "test"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  return dir;
}

// Async on purpose: the fixture HTTP servers run in this process, so a sync spawn would block the event loop and every page.goto would hang.
export function node(argv: string[], cwd: string, env: Record<string, string> = {}) {
  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("SNAPSEQ_")) spawnEnv[k] = v;
  }
  return new Promise<{ status: number | null; out: string }>((ok) => {
    const child = spawn(process.execPath, argv, { cwd, env: { ...spawnEnv, ...env } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => ok({ status, out }));
  });
}

export function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
