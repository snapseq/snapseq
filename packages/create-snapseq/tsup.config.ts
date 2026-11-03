import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = (name: string) => JSON.parse(readFileSync(new URL(`../${name}/package.json`, import.meta.url), "utf8"));
const core = pkg("snapseq");

// The versions the generated package.json files pin, read from the workspace at build time.
const VERSIONS = {
  snapseq: `^${core.version}`,
  "@snapseq/label": `^${pkg("label").version}`,
  "@snapseq/pdf": `^${pkg("pdf").version}`,
  "@playwright/test": `^${core.devDependencies["@playwright/test"]}`,
  "@types/node": core.devDependencies["@types/node"],
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: { VERSIONS: JSON.stringify(VERSIONS) },
});
