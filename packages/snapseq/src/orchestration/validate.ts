// What a run() can get wrong before any child starts. Each check throws its first problem with the path to
// the value and, where there are some, the valid names; run.ts adds the sequence and the call site.
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DeviceConfig } from "../define.js";
import type { ResolvedSnapseqConfig } from "./types.js";

const KEYS = ["envs", "defaultEnv", "devices", "sequencesDir", "screenshotsDir", "numbering", "format", "stabilize", "env", "host"];
const EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"];
const SEQUENCE_FILE = /\.seq\.[cm]?[jt]s$/;

export interface CheckContext {
  config: ResolvedSnapseqConfig;
  configDir: string;
  /** The Playwright overrides the config passes to defineConfig. */
  overrides: readonly unknown[];
  /** `--env`, or the SNAPSEQ_ENV snapseq started with. */
  invocationEnv?: string;
  /** The config's `defaultEnv` as written, which a child falls back to when nothing names an env. */
  defaultEnv?: string;
}

export interface Checked {
  /** The sequence's file, absolute. */
  file: string;
  /** Absolute. */
  sequencesDir: string;
  /** The run's devices in order: picked from the config's by name, or the run's own map. */
  devices: Record<string, DeviceConfig>;
  deviceOrder: string[];
}

/** One directory name, as defineConfig requires of a device or a run: no separators, not `.` or `..`. */
export const isDirName = (name: string): boolean =>
  name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);

/** A run's default name, a plain run's and an orchestration's alike: local time, the way Finder names screenshots, with a two-digit hour: `2026-10-01 at 04.07.16 PM`. */
export function runStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} at ${p(h % 12 || 12)}.${p(d.getMinutes())}.${p(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`;
}

export function isHttpUrl(host: string): boolean {
  try {
    const url = new URL(host);
    return /^https?:$/.test(url.protocol) && !!url.hostname;
  } catch {
    return false;
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

const prop = (path: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

function fail(message: string): never {
  throw new Error(message);
}

/** Why `value` would not reach the child as it is, or undefined when it is plain JSON. */
export function notJson(value: unknown, path: string, ancestors: readonly object[] = []): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${path} is ${value}`;
  if (value === undefined) return `${path} is undefined`;
  if (typeof value !== "object") return `${path} is a ${typeof value}`;
  if (ancestors.includes(value)) return `${path} refers back to itself`;
  const inside = [...ancestors, value];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = notJson(value[i], `${path}[${i}]`, inside);
      if (problem) return problem;
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    return `${path} is ${Buffer.isBuffer(value) ? "a Buffer" : `a ${value.constructor?.name ?? "class instance"}`}`;
  }
  for (const [key, v] of Object.entries(value)) {
    const problem = notJson(v, prop(path, key), inside);
    if (problem) return problem;
  }
  return undefined;
}

/** Sequence ids under `dir`, `nested/pricing` style, sorted; none when it cannot be read. */
export function sequenceIds(dir: string): string[] {
  try {
    const ids = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => SEQUENCE_FILE.test(f))
      .map((f) => f.replace(SEQUENCE_FILE, "").split(sep).join("/"));
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The files of `id` under `dir` as the disk spells them: names compared NFC, as macOS may keep them decomposed. */
function sequenceFiles(dir: string, id: string): string[] {
  const parts = id.normalize("NFC").split("/");
  const name = parts.pop()!;
  for (const part of parts) {
    const hit = entries(dir).find((entry) => entry.normalize("NFC") === part);
    if (hit === undefined) return [];
    dir = join(dir, hit);
  }
  const here = entries(dir);
  return EXTENSIONS.flatMap((ext) => here.filter((entry) => entry.normalize("NFC") === `${name}.seq.${ext}`)).map((entry) => join(dir, entry));
}

/** Everything about one run() that can be checked before a child starts. */
export function checkRun(sequence: unknown, options: unknown, playwright: readonly unknown[], ctx: CheckContext): Checked {
  const { config, configDir } = ctx;
  if (!isPlainObject(options)) return fail(`options must be an object, like { devices: ["desktop"] }`);
  for (const key of Object.keys(options)) {
    if (!KEYS.includes(key)) fail(`unknown option "${key}"; options take ${KEYS.join(", ")}`);
  }
  const problem = notJson(options, "options") ?? playwright.map((p, i) => notJson(p, `playwright[${i}]`)).find(Boolean);
  if (problem) fail(`${problem}; options and Playwright overrides reach the child as JSON`);
  playwright.forEach((p, i) => isPlainObject(p) || fail(`playwright[${i}] must be a Playwright config object`));
  const o = options as Record<string, unknown> & { devices?: unknown; envs?: unknown };

  // The sequence and its one file.
  const dirOption = o.sequencesDir ?? config.sequencesDir;
  if (typeof dirOption !== "string" || dirOption === "") fail(`options.sequencesDir must be a folder, got ${JSON.stringify(dirOption)}`);
  const sequencesDir = resolve(configDir, dirOption as string);
  if (typeof sequence !== "string" || isAbsolute(sequence) || !sequence.split("/").every(isDirName)) {
    fail(`a sequence id names a file in ${dirOption}/ without .seq.ts, like "12345-spring-launch"; got ${JSON.stringify(sequence)}`);
  }
  const files = sequenceFiles(sequencesDir, sequence as string);
  if (files.length === 0) {
    fail(`no ${dirOption}/${sequence}.seq.ts; sequences: ${sequenceIds(sequencesDir).join(", ") || "(none)"}`);
  }
  if (files.length > 1) fail(`one sequence, ${files.length} files: ${files.map((f) => relative(configDir, f)).join(", ")}; keep one`);

  // Devices: names pick from the config's in that order, a map replaces them.
  const named = Object.keys(config.devices);
  let devices: Record<string, DeviceConfig> = config.devices;
  let deviceOrder = named;
  if (Array.isArray(o.devices)) {
    if (o.devices.length === 0) fail("options.devices is empty; pick at least one device");
    devices = {};
    deviceOrder = [];
    o.devices.forEach((name: unknown, i) => {
      if (typeof name !== "string" || !Object.hasOwn(config.devices, name)) {
        fail(`unknown device ${JSON.stringify(name)} at options.devices[${i}]; devices: ${named.join(", ")}`);
      }
      if (Object.hasOwn(devices, name as string)) fail(`device "${name}" twice in options.devices, at [${i}]`);
      devices[name as string] = config.devices[name as string]!;
      deviceOrder.push(name as string);
    });
  } else if (o.devices !== undefined) {
    if (!isPlainObject(o.devices) || Object.keys(o.devices).length === 0) {
      fail("options.devices must be device names or a map of names to Playwright use options");
    }
    devices = o.devices as Record<string, DeviceConfig>;
    deviceOrder = Object.keys(devices);
    for (const name of deviceOrder) {
      const path = prop("options.devices", name);
      if (!isDirName(name)) fail(`${path}: a device name is a folder name, without / or \\`);
      if (!isPlainObject(devices[name])) fail(`${path} must be Playwright use options, like { viewport: { width: 1440, height: 900 } }`);
    }
  }
  // Picked from the config, by name or by default: they reach the child as JSON too.
  if (!isPlainObject(o.devices)) {
    for (const name of deviceOrder) {
      const problem = notJson(devices[name], prop("config.devices", name));
      if (problem) fail(`${problem}; a device reaches the child as JSON`);
    }
  }
  if (deviceOrder.length === 0) fail("the config has no devices; give this run some, like { devices: { desktop: { viewport: { width: 1440, height: 900 } } } }");

  // Envs and the host.
  if (o.envs !== undefined) {
    if (!isPlainObject(o.envs) || Object.keys(o.envs).length === 0) fail("options.envs must map env names to { host }");
    for (const [name, env] of Object.entries(o.envs as object)) {
      if (!isPlainObject(env) || typeof env.host !== "string") fail(`${prop("options.envs", name)} needs a host`);
    }
  }
  const envs = (o.envs ?? config.envs) as Record<string, { use?: Record<string, unknown> }>;
  const envNames = Object.keys(envs).join(", ");
  const known = (name: unknown): boolean => typeof name === "string" && Object.hasOwn(envs, name);
  for (const key of ["env", "defaultEnv"]) {
    if (o[key] !== undefined && !known(o[key])) fail(`unknown env ${JSON.stringify(o[key])} at options.${key}; envs: ${envNames}`);
  }
  if (ctx.invocationEnv !== undefined && !known(ctx.invocationEnv)) {
    fail(`unknown env "${ctx.invocationEnv}" from --env or SNAPSEQ_ENV; this run's envs: ${envNames}`);
  }
  const fallback = o.defaultEnv ?? ctx.defaultEnv;
  if (o.env === undefined && ctx.invocationEnv === undefined && fallback !== undefined && !known(fallback)) {
    fail(`the config's defaultEnv "${fallback}" is not in options.envs (${envNames}); name one with env: "${Object.keys(envs)[0]}" or defaultEnv`);
  }
  if (o.host !== undefined && (typeof o.host !== "string" || !isHttpUrl(o.host))) {
    fail(`options.host must be an http(s) URL, got ${JSON.stringify(o.host)}`);
  }

  // The host is the baseURL: nothing else may set it.
  const baseURLs: [string, unknown][] = [];
  if (isPlainObject(o.devices)) for (const name of deviceOrder) baseURLs.push([prop("options.devices", name), devices[name]]);
  if (o.envs !== undefined) for (const name of Object.keys(envs)) baseURLs.push([`${prop("options.envs", name)}.use`, envs[name]?.use]);
  const layers: [string, Record<string, unknown>][] = [
    ...ctx.overrides.map((p, i) => [`the config's override [${i}]`, p] as [string, Record<string, unknown>]),
    ...playwright.map((p, i) => [`playwright[${i}]`, p] as [string, Record<string, unknown>]),
  ];
  for (const [path, layer] of layers) {
    if (!isPlainObject(layer)) continue;
    const projects = Array.isArray(layer.projects) ? (layer.projects as Record<string, unknown>[]) : [];
    for (const [at, level] of [[path, layer], ...projects.map((p, j) => [`${path}.projects[${j}]`, p] as const)] as const) {
      if (!isPlainObject(level)) continue;
      if (path.startsWith("playwright")) baseURLs.push([`${at}.use`, level.use]);
    }
  }
  // retries and repeatEach as the child ends up with them: each override in order, the config's first, at the top
  // level, and on a selected device's project what an override sets on a project of that name.
  const top: Record<string, unknown> = {};
  const selected = new Map(deviceOrder.map((name) => [name, {} as Record<string, unknown>]));
  const pick = (into: Record<string, unknown> | undefined, from: Record<string, unknown>): void => {
    for (const key of ["retries", "repeatEach"]) if (into && Object.hasOwn(from, key)) into[key] = from[key];
  };
  for (const [, layer] of layers) {
    if (!isPlainObject(layer)) continue;
    pick(top, layer);
    for (const p of Array.isArray(layer.projects) ? layer.projects : []) if (isPlainObject(p)) pick(selected.get(p.name as string), p);
  }
  for (const [at, level] of [["", top], ...[...selected].map(([name, p]) => [` on project "${name}"`, p] as const)] as const) {
    if (typeof level.retries === "number" && level.retries > 0) {
      fail(`retries is ${level.retries}${at} after the overrides merge; a retry overwrites the shots: catch the rejection and call run() again`);
    }
    if (typeof level.repeatEach === "number" && level.repeatEach > 1) {
      fail(`repeatEach is ${level.repeatEach}${at} after the overrides merge; a sequence runs once per device`);
    }
  }
  for (const [path, use] of baseURLs) {
    if (isPlainObject(use) && use.baseURL !== undefined) fail(`${path}.baseURL is set; the host comes from the env, \`host\` or --host`);
  }

  if (o.numbering !== undefined && (typeof o.numbering !== "string" || !/^0+$/.test(o.numbering))) {
    fail(`options.numbering must be zeros, like "00", not ${JSON.stringify(o.numbering)}`);
  }
  if (o.screenshotsDir !== undefined && (typeof o.screenshotsDir !== "string" || o.screenshotsDir === "")) {
    fail(`options.screenshotsDir must be a folder, got ${JSON.stringify(o.screenshotsDir)}`);
  }
  return { file: files[0]!, sequencesDir, devices, deviceOrder };
}
