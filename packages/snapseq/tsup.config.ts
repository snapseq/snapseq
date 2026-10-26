import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    target: "node20",
    // Only orchestration/request.ts's distFile reads import.meta.url here, and only on
    // the ESM path (guarded by typeof __dirname); the CJS bundle still carries the
    // token, which esbuild flags.
    esbuildOptions(options) {
      options.logOverride = { "empty-import-meta": "silent" };
    },
  },
  {
    entry: ["src/cli.ts", "src/reporter.ts", "src/orchestration/result-reporter.ts"],
    format: ["esm"],
    target: "node20",
  },
]);
