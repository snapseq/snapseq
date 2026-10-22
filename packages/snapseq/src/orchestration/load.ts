import { existsSync } from "node:fs";
import type { PlaywrightTestConfig } from "@playwright/test";
import type { Jiti } from "jiti";
import type { Orchestration, ResolvedSnapseqConfig } from "./types.js";

/** What defineConfig keeps for the parent under Symbol.for("snapseq.inputs"). */
export interface Inputs {
  config: ResolvedSnapseqConfig;
  overrides: PlaywrightTestConfig[];
  /** The config's `defaultEnv` as written, before a default is filled in. */
  defaultEnv?: string;
}

/**
 * The config through jiti, rooted at the config file so the orchestration resolves imports (tsconfig paths
 * too) the way the config does. SNAPSEQ_ENV and SNAPSEQ_HOST are out of the environment while it loads, so it
 * resolves the default env and cannot fail on an env a run brings in later.
 */
export async function loadConfig(file: string): Promise<{ jiti: Jiti; inputs: Inputs }> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(file, { tsconfigPaths: true });
  const saved = { SNAPSEQ_ENV: process.env.SNAPSEQ_ENV, SNAPSEQ_HOST: process.env.SNAPSEQ_HOST };
  delete process.env.SNAPSEQ_ENV;
  delete process.env.SNAPSEQ_HOST;
  let result: Record<symbol, unknown> | undefined;
  try {
    result = await jiti.import<Record<symbol, unknown>>(file, { default: true });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
  const inputs = result?.[Symbol.for("snapseq.inputs")] as Inputs | undefined;
  if (!inputs?.config) {
    throw new Error(`snapseq: ${file} must export default defineConfig(…) from snapseq 0.7 or newer to run an orchestration`);
  }
  return { jiti, inputs };
}

/** `file` absolute: jiti reads a relative `snapseq/spring.orchestration.ts` as a package's subpath. */
export async function loadOrchestration(jiti: Jiti, file: string): Promise<Orchestration> {
  if (!existsSync(file)) throw new Error(`snapseq: no orchestration file at ${file}`);
  const fn = await jiti.import(file, { default: true });
  if (typeof fn !== "function") {
    throw new Error(
      `snapseq: ${file} must export default the orchestration: export default defineOrchestration(async ({ run, config, dir }) => { … })`,
    );
  }
  return fn as Orchestration;
}
