import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

// Filled in by tsup from the workspace's package.json files.
declare const VERSIONS: Record<"snapseq" | "@snapseq/label" | "@snapseq/pdf" | "@playwright/test" | "@types/node", string>;

const USAGE = `Usage: create-snapseq [dir] [--site <url>]... [--multisite] [--no-install]

  dir           the folder to create (asked for on a terminal)
  --site <url>  a site to shoot; repeat it for more
  --multisite   a pnpm workspace with a package per site
  --no-install  write the files and stop
  --help        this text

npm passes flags after "--": npm create snapseq@latest -- my-shots --site https://www.example.com`;

interface Site {
  name: string;
  host: string;
  path: string;
  env: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const fail = (msg: string): never => {
  throw new Error(msg);
};

function parseSite(input: string): Site {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail(`${input}: not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail(`${input}: only http and https`);
  if (url.username || url.password) return fail(`${input}: a URL with credentials`);
  const name = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) return fail(`${input}: use a hostname`);
  const env = name === "localhost" || name === "127.0.0.1" ? "dev" : "prod";
  return { name, host: url.origin, path: url.pathname.replace(/^\/+/, "/"), env };
}

const isMultisiteRoot = (root: string) => {
  const kind = (f: string) => statSync(join(root, f), { throwIfNoEntry: false });
  return Boolean(kind("pnpm-workspace.yaml")?.isFile() && kind("sites")?.isDirectory() && kind(join("packages", "shared"))?.isDirectory());
};

/** Whether anything is at `path`, a dangling link included. */
const taken = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** `path` with its links resolved, as far up as it exists. */
function real(path: string): string {
  return existsSync(path) || dirname(path) === path ? realpathSync(path) : join(real(dirname(path)), basename(path));
}

/** A word the shell reads as itself. */
const shellWord = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The nearest folder above `start` that is a git repo or a workspace, if any. */
function enclosingRepo(start: string): string | undefined {
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, "pnpm-workspace.yaml"))) return d;
    try {
      if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).workspaces) return d;
    } catch {}
    if (dirname(d) === d) return undefined;
  }
}

const devDependencies = (extra: Record<string, string> = {}) => ({
  "@playwright/test": VERSIONS["@playwright/test"],
  "@snapseq/label": VERSIONS["@snapseq/label"],
  "@snapseq/pdf": VERSIONS["@snapseq/pdf"],
  "@types/node": VERSIONS["@types/node"],
  snapseq: VERSIONS.snapseq,
  ...extra,
});

const config = (site: Site, shared: boolean) => `import { defineConfig } from "snapseq";${shared ? '\nimport { devices } from "shared";' : ""}

export default defineConfig({${shared ? "\n  devices," : ""}
  envs: {
    ${site.env}: { host: ${JSON.stringify(site.host)} },
  },
});
`;

const goto = (path: string) => `await page.goto(${JSON.stringify(path)});`;
const sequenceFile = (site: Site) => `import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  ${(goto(site.path) + " ").padEnd(54)}// relative to the env's host
  await seq.snap({ label: "Home" });                    // 01.png, the viewport
  await seq.snapPage({ label: "Home, full page" });     // 02.png, the whole page
});
`;

const ORCHESTRATION = `import { join } from "node:path";
import { defineOrchestration } from "snapseq";
import { label } from "@snapseq/label";
import { pdf } from "@snapseq/pdf";

// \`snapseq -o pdf\`: shoots the sequences, puts each shot's label on a strip above it,
// and binds one PDF per device in the run folder.
export default defineOrchestration(async ({ run, dir }) => {
  const raw = [
    ...(await run("home")),  // one run() per sequence, in the order the PDF follows
  ];
  const labelled = await label(raw);
  for (const device of new Set(labelled.map((c) => c.device))) {
    await pdf(labelled.filter((c) => c.device === device), join(dir, \`\${device}.pdf\`));
  }
});
`;

const SHARED_INDEX = `// Every site takes its devices from here: one edit changes them all.
// Helpers two sites need go in this package too.
export const devices = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
};
`;

const tsconfig = (include: string[]) =>
  json({
    compilerOptions: {
      target: "ES2022",
      module: "preserve",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include,
  });

function writeAll(root: string, files: Record<string, string>) {
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
}

const siteFiles = (site: Site, prefix: string, shared: boolean): Record<string, string> => ({
  [`${prefix}snapseq.config.ts`]: config(site, shared),
  [`${prefix}snapseq/home.seq.ts`]: sequenceFile(site),
  [`${prefix}snapseq/pdf.orchestration.ts`]: ORCHESTRATION,
});

const run = (cmd: string, args: string[], cwd: string, stdio: "inherit" | "ignore" = "inherit") =>
  spawnSync(cmd, args, { cwd, stdio, shell: process.platform === "win32" }).status === 0;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      site: { type: "string", multiple: true },
      multisite: { type: "boolean" },
      "no-install": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(USAGE);
  if (positionals.length > 1) fail(`one folder at most, got ${positionals.length}\n\n${USAGE}`);

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  // One iterator for every answer, so lines pasted ahead of a prompt are queued, not dropped.
  const lines = rl?.[Symbol.asyncIterator]();
  const ask = async (q: string) => {
    process.stdout.write(q);
    return String((await lines!.next()).value ?? "").trim();
  };
  const missing = (what: string): never => fail(`${what}\n\n${USAGE}`);

  try {
    const dir = positionals[0] || (tty ? await ask("Folder: ") : missing("missing the folder: pass it as the first argument"));
    if (!dir) missing("missing the folder");
    const root = resolve(dir);
    const adding = existsSync(root) && isMultisiteRoot(root);

    const inputs = values.site ?? [];
    if (!adding && !values.multisite && inputs.length > 1) {
      fail("two sites need --multisite (dev, staging and prod of one site are envs in one config, not sites)");
    }
    let multisite = adding || Boolean(values.multisite) || inputs.length > 1;
    if (!multisite && inputs.length === 0 && tty) multisite = /^m/i.test(await ask("Single site or multisite? [s/m] "));
    if (inputs.length === 0) {
      if (!tty) missing("missing --site <url>");
      if (multisite) {
        for (let line; (line = await ask("Site URL (an empty line ends): ")); ) inputs.push(line);
      } else {
        inputs.push(await ask("Site URL: "));
      }
      if (inputs.length === 0 || inputs.some((s) => !s)) missing("missing --site <url>");
    }

    const sites = inputs.map(parseSite);
    const dup = sites.find((s, i) => sites.findIndex((t) => t.name === s.name) !== i);
    if (dup) fail(`two URLs give the site name ${dup.name}`);

    // Guards: all of them before anything is written.
    if (adding) {
      for (const s of sites) if (taken(join(root, "sites", s.name))) fail(`${join(root, "sites", s.name)} already exists`);
    } else {
      if (existsSync(root) && readdirSync(root).length > 0) fail(`${root} is not empty`);
      const repo = enclosingRepo(dirname(real(root)));
      if (repo) fail(`${repo} is a repo/workspace; pick a folder outside it`);
    }
    rl?.close();
    const agent = process.env.npm_config_user_agent ?? "";
    const install = !values["no-install"];
    if (multisite && install && !agent.startsWith("pnpm/") && !run("pnpm", ["--version"], process.cwd(), "ignore")) {
      fail('multisite uses pnpm: run "corepack enable pnpm" or install pnpm, or pass --no-install');
    }

    const launcher = agent.split("/")[0] ?? "";
    const pm = multisite ? "pnpm" : ["pnpm", "yarn", "bun"].includes(launcher) ? launcher : "npm";
    const pnpmVersion = /^pnpm\/(\S+)/.exec(agent)?.[1];
    const base = {
      name: basename(root).toLowerCase().replace(/[^a-z0-9._~-]/g, "-").replace(/^[._]/, "-"),
      private: true,
      type: "module",
    };
    const packageManager = pnpmVersion ? { packageManager: `pnpm@${pnpmVersion}` } : {};

    if (multisite) {
      const files: Record<string, string> = {};
      if (!adding) {
        Object.assign(files, {
          "package.json": json({
            ...base,
            scripts: { snapseq: 'pnpm -r --workspace-concurrency=1 --filter "./sites/**" exec snapseq' },
            devDependencies: { "@types/node": VERSIONS["@types/node"] },
            ...packageManager,
          }),
          "pnpm-workspace.yaml": "packages:\n  - sites/*\n  - packages/*\n",
          "packages/shared/package.json": json({ name: "shared", private: true, type: "module", exports: "./src/index.ts" }),
          "packages/shared/src/index.ts": SHARED_INDEX,
          "tsconfig.json": tsconfig(["sites/*/snapseq.config.ts", "sites/*/snapseq", "packages/shared/src"]),
          ".gitignore": "node_modules/\n",
        });
      }
      for (const s of sites) {
        Object.assign(files, siteFiles(s, `sites/${s.name}/`, true), {
          [`sites/${s.name}/package.json`]: json({
            name: s.name,
            private: true,
            type: "module",
            devDependencies: devDependencies({ shared: "workspace:*" }),
          }),
        });
      }
      writeAll(root, files);
    } else {
      writeAll(root, {
        "package.json": json({ ...base, devDependencies: devDependencies(), ...packageManager }),
        "tsconfig.json": tsconfig(["snapseq.config.ts", "snapseq"]),
        ".gitignore": "node_modules/\n",
        ...siteFiles(sites[0]!, "", false),
      });
    }
    console.log(`Wrote ${adding ? sites.map((s) => `sites/${s.name}`).join(", ") + " in " : ""}${root}`);

    // Install the dependencies and the browser; whatever is not done is printed as a command to run.
    const where = relative(process.cwd(), root) || ".";
    const cd = where.startsWith("..") ? root : where;
    const first = sites[0]!.name;
    const exec = { pnpm: ["pnpm"], npm: ["npx"], yarn: ["yarn"], bun: ["bunx"] }[pm]!;
    const browser = [...(multisite ? ["pnpm", "--filter", first, "exec"] : exec), "playwright", "install", "chromium"];
    const todo: string[] = [];
    if (install) {
      if (!run(pm, ["install"], root)) {
        console.error(`create-snapseq: "${pm} install" failed; fix that, then run it in ${root}`);
        process.exitCode = 1;
        return;
      }
      if (Number(process.versions.node.split(".")[0]) >= 26) {
        console.log(`Node 26 hangs on playwright install; run it under Node 22: ${browser.join(" ")}`);
      } else if (!run(browser[0]!, browser.slice(1), root)) {
        console.error(`create-snapseq: the browser install failed; run it in ${root}: ${browser.join(" ")}`);
        process.exitCode = 1;
        return;
      }
    } else {
      todo.push(`${pm} install`, browser.join(" "));
    }

    const snapseq = (pm === "npm" ? "npx snapseq" : `${pm} snapseq`) + " -o pdf";
    const next = [
      ...(cd === "." ? [] : [`cd ${shellWord(cd)}`]),
      ...todo,
      multisite ? `pnpm snapseq -o pdf   # every site` : snapseq,
      ...(multisite ? [`pnpm --filter ${first} exec snapseq -o pdf   # one site`] : []),
    ];
    console.log(`\nNext:\n${next.map((c) => `  ${c}`).join("\n")}`);
    console.log("\nA run writes screenshots/<run>/ with desktop.pdf and mobile.pdf.");
  } finally {
    rl?.close();
  }
}

main().catch((e: Error) => {
  console.error(`create-snapseq: ${e.message}`);
  process.exitCode = 1;
});
