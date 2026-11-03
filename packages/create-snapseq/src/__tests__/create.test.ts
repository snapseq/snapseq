import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Spawns the BUILT bin, the way npm create does, with stdin not a terminal.
const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
const bases: string[] = [];
const base = () => {
  const dir = mkdtempSync(join(tmpdir(), "create-snapseq-"));
  bases.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of bases) rmSync(d, { recursive: true, force: true });
});

const create = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  // The test runner may itself be launched by pnpm; start from no launcher.
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, npm_config_user_agent: "", ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

/** Every file under `dir`, relative and sorted. */
const files = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => lstatSync(join(dir, f)).isFile())
    .sort();
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const json = (...p: string[]) => JSON.parse(read(...p));

const SINGLE = [".gitignore", "package.json", "snapseq.config.ts", "snapseq/home.seq.ts", "snapseq/pdf.orchestration.ts", "tsconfig.json"];
const site = (name: string) => [`sites/${name}/package.json`, `sites/${name}/snapseq.config.ts`, `sites/${name}/snapseq/home.seq.ts`, `sites/${name}/snapseq/pdf.orchestration.ts`];

describe("a single site", () => {
  it("writes the files with the host and the path in them", () => {
    const cwd = base();
    const r = create(cwd, ["My Shots", "--site", "https://www.Example.com/pricing?x=1", "--no-install"]);
    expect(r.status, r.err).toBe(0);
    const dir = join(cwd, "My Shots");
    expect(files(dir)).toEqual(SINGLE);
    expect(read(dir, "snapseq.config.ts")).toBe(`import { defineConfig } from "snapseq";

export default defineConfig({
  envs: {
    prod: { host: "https://www.example.com" },
  },
});
`);
    expect(read(dir, "snapseq/home.seq.ts")).toContain(`await page.goto("/pricing");`);
    expect(read(dir, "snapseq/pdf.orchestration.ts")).toContain(`await run("home")`);
    expect(read(dir, ".gitignore")).toBe("node_modules/\n");
    const pkg = json(dir, "package.json");
    expect(pkg).toMatchObject({ name: "my-shots", private: true, type: "module" });
    expect(Object.keys(pkg.devDependencies)).toEqual(["@playwright/test", "@snapseq/label", "@snapseq/pdf", "@types/node", "snapseq"]);
    expect(pkg.devDependencies.snapseq).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.packageManager).toBeUndefined();
    expect(r.out).toContain("npx snapseq -o pdf");
  });

  it("names a local site's env dev, and pins the package manager when pnpm launched it", () => {
    const cwd = base();
    const r = create(cwd, ["app", "--site", "http://localhost:3000", "--no-install"], { npm_config_user_agent: "pnpm/10.20.0 npm/? node/v22.0.0 darwin arm64" });
    expect(r.status, r.err).toBe(0);
    expect(read(cwd, "app/snapseq.config.ts")).toContain(`dev: { host: "http://localhost:3000" }`);
    expect(json(cwd, "app/package.json").packageManager).toBe("pnpm@10.20.0");
    expect(r.out).toContain("pnpm snapseq -o pdf");
  });

  it("keeps a path that starts with // on the site's host, and quotes the folder for the shell", () => {
    const cwd = base();
    const r = create(cwd, ["a&b", "--site", "https://example.com//other.example/page", "--no-install"]);
    expect(r.status, r.err).toBe(0);
    expect(read(cwd, "a&b/snapseq/home.seq.ts")).toContain(`await page.goto("/other.example/page");`);
    expect(r.out).toContain("cd 'a&b'");
  });

  it("goes into an empty folder that exists", () => {
    const cwd = base();
    mkdirSync(join(cwd, "app"));
    expect(create(cwd, ["app", "--site", "https://example.com", "--no-install"]).status).toBe(0);
    expect(files(join(cwd, "app"))).toEqual(SINGLE);
  });
});

describe("a multisite repo", () => {
  it("writes a workspace with a package per site and a shared one", () => {
    const cwd = base();
    const r = create(cwd, ["shots", "--multisite", "--site", "https://www.a.example.com/x", "--site", "http://127.0.0.1:8080", "--no-install"]);
    expect(r.status, r.err).toBe(0);
    const dir = join(cwd, "shots");
    expect(files(dir)).toEqual(
      [".gitignore", "package.json", "packages/shared/package.json", "packages/shared/src/index.ts", "pnpm-workspace.yaml", "tsconfig.json", ...site("a.example.com"), ...site("127.0.0.1")].sort(),
    );
    expect(read(dir, "pnpm-workspace.yaml")).toBe("packages:\n  - sites/*\n  - packages/*\n");
    const root = json(dir, "package.json");
    expect(root.scripts.snapseq).toBe('pnpm -r --workspace-concurrency=1 --filter "./sites/**" exec snapseq');
    expect(root.devDependencies).toEqual({ "@types/node": expect.any(String) });
    expect(json(dir, "tsconfig.json").include).toEqual(["sites/*/snapseq.config.ts", "sites/*/snapseq", "packages/shared/src"]);
    expect(json(dir, "packages/shared/package.json")).toEqual({ name: "shared", private: true, type: "module", exports: "./src/index.ts" });
    expect(read(dir, "packages/shared/src/index.ts")).toContain("export const devices");
    expect(read(dir, "sites/a.example.com/snapseq.config.ts")).toBe(`import { defineConfig } from "snapseq";
import { devices } from "shared";

export default defineConfig({
  devices,
  envs: {
    prod: { host: "https://www.a.example.com" },
  },
});
`);
    expect(read(dir, "sites/127.0.0.1/snapseq.config.ts")).toContain(`dev: { host: "http://127.0.0.1:8080" }`);
    expect(json(dir, "sites/a.example.com/package.json")).toMatchObject({ name: "a.example.com", devDependencies: { shared: "workspace:*", snapseq: expect.any(String) } });
    expect(r.out).toContain("pnpm --filter a.example.com exec snapseq -o pdf");
  });

  it("is implied by two --site flags only with --multisite", () => {
    const cwd = base();
    const r = create(cwd, ["shots", "--site", "https://a.com", "--no-install", "--multisite"]);
    expect(r.status, r.err).toBe(0);
    expect(files(join(cwd, "shots"))).toContain("sites/a.com/package.json");
  });

  it("adds a site to an existing root and changes nothing else", () => {
    const cwd = base();
    expect(create(cwd, ["shots", "--site", "https://a.com", "--no-install", "--multisite"]).status).toBe(0);
    const dir = join(cwd, "shots");
    mkdirSync(join(dir, ".git")); // a multisite root is usually a repo
    const before = Object.fromEntries(files(dir).map((f) => [f, read(dir, f)]));
    const r = create(cwd, ["shots", "--site", "https://www.b.com/shop", "--no-install"]);
    expect(r.status, r.err).toBe(0);
    expect(files(dir).filter((f) => !(f in before))).toEqual(site("b.com"));
    for (const [f, src] of Object.entries(before)) expect(read(dir, f), f).toBe(src);
    expect(read(dir, "sites/b.com/snapseq/home.seq.ts")).toContain(`"/shop"`);
  });
});

describe("refusals", () => {
  const AGENT = "npm/10.0.0 node/v22.0.0";
  // Each case sets up `cwd`, then gives the args; the target is always `cwd/out`.
  const cases: Record<string, { setup?: (cwd: string) => void; args: string[]; env?: Record<string, string>; err: RegExp }> = {
    "a folder that is not empty": {
      setup: (cwd) => (mkdirSync(join(cwd, "out")), writeFileSync(join(cwd, "out", "a.txt"), "x")),
      args: ["out", "--site", "https://a.com"],
      err: /is not empty/,
    },
    "a folder inside a git repo": {
      setup: (cwd) => mkdirSync(join(cwd, ".git")),
      args: ["out", "--site", "https://a.com"],
      err: /is a repo\/workspace; pick a folder outside it/,
    },
    "a folder inside a pnpm workspace": {
      setup: (cwd) => writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages: []\n"),
      args: ["out", "--site", "https://a.com"],
      err: /is a repo\/workspace/,
    },
    "a folder inside an npm workspace": {
      setup: (cwd) => writeFileSync(join(cwd, "package.json"), '{ "workspaces": ["*"] }'),
      args: ["out", "--site", "https://a.com"],
      err: /is a repo\/workspace/,
    },
    "a folder linked into a git repo": {
      setup: (cwd) => (mkdirSync(join(cwd, "repo", ".git"), { recursive: true }), mkdirSync(join(cwd, "repo", "empty")), symlinkSync(join(cwd, "repo", "empty"), join(cwd, "out"))),
      args: ["out", "--site", "https://a.com"],
      err: /repo is a repo\/workspace/,
    },
    "a folder that only looks like a multisite root": {
      setup: (cwd) => {
        mkdirSync(join(cwd, "out", "sites"), { recursive: true });
        mkdirSync(join(cwd, "out", "packages"));
        writeFileSync(join(cwd, "out", "pnpm-workspace.yaml"), "");
        writeFileSync(join(cwd, "out", "packages", "shared"), "");
      },
      args: ["out", "--site", "https://a.com"],
      err: /is not empty/,
    },
    "two sites without --multisite": {
      args: ["out", "--site", "https://a.com", "--site", "https://b.com"],
      err: /two sites need --multisite \(dev, staging and prod of one site are envs in one config, not sites\)/,
    },
    "no --site off a terminal": { args: ["out"], err: /missing --site <url>[^]*Usage:/ },
    "no folder off a terminal": { args: ["--site", "https://a.com"], err: /missing the folder[^]*Usage:/ },
    "credentials in a URL": { args: ["out", "--site", "https://u:p@a.com"], err: /a URL with credentials/ },
    "a URL that is not http": { args: ["out", "--site", "ftp://a.com"], err: /only http and https/ },
    "a URL that is not a URL": { args: ["out", "--site", "nonsense"], err: /not a URL/ },
    "a host that is not a hostname": { args: ["out", "--site", "http://[::1]:3000"], err: /use a hostname/ },
    "two URLs with one name": {
      args: ["out", "--multisite", "--site", "https://www.a.com", "--site", "http://a.com:81"],
      err: /two URLs give the site name a\.com/,
    },
    "a site that already exists": {
      setup: (cwd) => {
        create(cwd, ["out", "--multisite", "--site", "https://a.com", "--no-install"]);
        writeFileSync(join(cwd, "out", "sites", "a.com", "keep.txt"), "x");
      },
      args: ["out", "--site", "https://a.com"],
      err: /already exists/,
    },
    "a dangling link where a new site goes": {
      setup: (cwd) => {
        create(cwd, ["out", "--multisite", "--site", "https://a.com", "--no-install"]);
        symlinkSync(join(cwd, "nowhere"), join(cwd, "out", "sites", "b.com"));
      },
      args: ["out", "--site", "https://c.com", "--site", "https://b.com"],
      err: /b\.com already exists/,
    },
    "a multisite repo with no pnpm to install with": {
      args: ["out", "--multisite", "--site", "https://a.com"],
      env: { npm_config_user_agent: AGENT, PATH: "" },
      err: /multisite uses pnpm: run "corepack enable pnpm" or install pnpm, or pass --no-install/,
    },
  };

  it.each(Object.entries(cases))("%s", (_name, c) => {
    const cwd = base();
    c.setup?.(cwd);
    const before = files(cwd).map((f) => [f, statSync(join(cwd, f)).mtimeMs]);
    const r = create(cwd, c.args, c.env);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(c.err);
    expect(files(cwd).map((f) => [f, statSync(join(cwd, f)).mtimeMs])).toEqual(before);
  });
});
