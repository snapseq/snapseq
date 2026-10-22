import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG } from "./helpers";

// A consumer in a scratch dir imports the BUILT packages by name. Types must come from
// index.d.ts under ESM and index.d.cts under CJS, or node16 resolution raises TS1479.
const PACKAGES = resolve(PKG, "..");
const TSC = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/.bin/tsc");
const LINKS: Record<string, string> = {
  snapseq: PKG,
  "@snapseq/label": join(PACKAGES, "label"),
  "@snapseq/pdf": join(PACKAGES, "pdf"),
  "@playwright/test": join(PKG, "node_modules/@playwright/test"),
};

const BODY = `
import { defineConfig, defineOrchestration, sequence, type Capture } from "snapseq";
import { label } from "@snapseq/label";
import { pdf } from "@snapseq/pdf";

export const config = defineConfig({
  envs: { dev: { host: "http://localhost:3000" } },
  stabilize: { motion: false },
});

export const orchestration = defineOrchestration(async ({ run, dir }) => {
  const raw: readonly Capture[] = await run("home", { devices: ["desktop"], stabilize: false });
  const labelled: Capture[] = await label(raw, { theme: "dark" });
  await pdf(labelled, dir + "/home.pdf");
});

sequence(async ({ seq }) => {
  await seq.snap({ label: "x", hover: "keep" });
});
`;

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "snapseq-exports-"));
  for (const [name, target] of Object.entries(LINKS)) {
    mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
    symlinkSync(target, join(dir, "node_modules", name), "dir");
  }
  writeFileSync(join(dir, "consumer.mts"), BODY);
  writeFileSync(join(dir, "consumer.cts"), BODY);
  for (const mode of ["node16", "nodenext"]) {
    writeFileSync(
      join(dir, `tsconfig.${mode}.json`),
      JSON.stringify({
        compilerOptions: { module: mode, moduleResolution: mode, target: "ES2022", strict: true, skipLibCheck: true, noEmit: true },
        include: ["consumer.mts", "consumer.cts"],
      }),
    );
  }
  writeFileSync(
    join(dir, "resolve.mjs"),
    `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const names = ${JSON.stringify(["snapseq", "@snapseq/label", "@snapseq/pdf"])};
console.log(JSON.stringify(Object.fromEntries(names.map((n) => [n, { require: require.resolve(n), import: import.meta.resolve(n) }]))));
`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("package exports", () => {
  it.each(["node16", "nodenext"])("type-checks from an ESM and a CJS consumer under %s", (mode) => {
    const r = spawnSync(TSC, ["-p", `tsconfig.${mode}.json`], { cwd: dir, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).not.toMatch(/TS1479|TS2307/);
    expect(out).toBe("");
    expect(r.status).toBe(0);
  });

  it("resolves index.cjs for require and index.js for import", () => {
    const r = spawnSync(process.execPath, ["resolve.mjs"], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const found = JSON.parse(r.stdout) as Record<string, { require: string; import: string }>;
    for (const [name, hit] of Object.entries(found)) {
      expect(basename(hit.require), name).toBe("index.cjs");
      expect(basename(new URL(hit.import).pathname), name).toBe("index.js");
    }
  });
});
