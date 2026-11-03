import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { node } from "../../snapseq/src/__tests__/harness.js";
import { PKG, pdfPages, snapseq, startServer } from "./helpers";

// What `create-snapseq` writes, shot against a local server: the scaffold runs as it is, with only the
// install replaced by links to the workspace's built packages.
const PACKAGES = resolve(PKG, "..");
const CREATE = join(PACKAGES, "create-snapseq", "dist", "index.js");

type Server = Awaited<ReturnType<typeof startServer>>;
let server: Server;
let port: string;
const bases: string[] = [];

beforeAll(async () => {
  server = await startServer();
  port = new URL(server.url).port;
});
afterAll(async () => {
  await server.close();
  for (const d of bases) rmSync(d, { recursive: true, force: true });
});

/** Scaffold into a fresh folder with `args`; the folder. */
async function scaffold(args: string[]) {
  const base = mkdtempSync(join(tmpdir(), "snapseq-create-"));
  bases.push(base);
  const dir = join(base, "app");
  const r = await node([CREATE, dir, ...args, "--no-install"], base, { npm_config_user_agent: "" });
  expect(r.status, r.out).toBe(0);
  return dir;
}

/** What `install` would leave in `dir`: the packages and Playwright linked into node_modules. */
function link(dir: string, shared?: string) {
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@playwright"), { recursive: true });
  mkdirSync(join(modules, "@snapseq"), { recursive: true });
  symlinkSync(PKG, join(modules, "snapseq"));
  symlinkSync(join(PKG, "node_modules", "@playwright", "test"), join(modules, "@playwright", "test"));
  symlinkSync(join(PACKAGES, "label"), join(modules, "@snapseq", "label"));
  symlinkSync(join(PACKAGES, "pdf"), join(modules, "@snapseq", "pdf"));
  if (shared) symlinkSync(shared, join(modules, "shared"));
}

/** `snapseq -o pdf` in `dir`, and what must be on disk after it. */
async function shoot(dir: string) {
  const r = await snapseq(dir, ["-o", "pdf", "--run", "e2e"]);
  expect(r.status, r.out).toBe(0);
  const run = join(dir, "screenshots", "e2e");
  for (const device of ["desktop", "mobile"]) {
    expect((await pdfPages(join(run, `${device}.pdf`))).length, device).toBe(2);
    expect(existsSync(join(run, "home", device, "labelled", "01.png")), device).toBe(true);
  }
}

describe("create-snapseq", () => {
  it("a single site runs `snapseq -o pdf` as scaffolded", async () => {
    const dir = await scaffold(["--site", `http://localhost:${port}`]);
    link(dir);
    await shoot(dir);
  });

  it("a multisite repo runs `snapseq -o pdf` in each site", async () => {
    const dir = await scaffold(["--multisite", "--site", `http://localhost:${port}`, "--site", `http://127.0.0.1:${port}`]);
    for (const name of ["localhost", "127.0.0.1"]) {
      const site = join(dir, "sites", name);
      link(site, join(dir, "packages", "shared"));
      await shoot(site);
    }
  });
});
