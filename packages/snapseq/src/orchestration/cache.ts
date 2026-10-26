// The run cache (node_modules/.cache/snapseq/runs/<run>.json) and its lock: what lets a filtered run reuse
// the parts it does not reshoot. Outside Playwright's outputDir, which Playwright empties before each run.
import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capture } from "./types.js";

export type CachedCapture = Omit<Capture, "reused">;

/** Where a capture came from; reuse needs all four to be what they are now. Canonical paths. */
export interface Origin {
  configFile: string;
  sequencesDir: string;
  sequenceFile: string;
  screenshotsDir: string;
}

interface CacheEntry extends Origin {
  capture: CachedCapture;
}

export interface RunCache {
  version: 1;
  /** By `<sequence>/<device>`. */
  entries: Record<string, CacheEntry>;
}

/** snapseq's folder in node_modules/.cache, relative to the config's folder; Playwright's outputDir is a folder inside it. */
export const CACHE_DIR = join("node_modules", ".cache", "snapseq");

export const cacheDir = (configDir: string): string => join(configDir, CACHE_DIR);

export const runCacheFile = (configDir: string, run: string): string => join(cacheDir(configDir), "runs", `${run}.json`);

export const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The pid a lock file holds; NaN when it is empty, unreadable or not a pid (a lock being written counts as busy). */
const pidIn = (file: string): number => {
  try {
    const text = readFileSync(file, "utf8");
    return /^[1-9]\d*$/.test(text) ? Number(text) : Number.NaN;
  } catch {
    return Number.NaN;
  }
};

const stale = (pid: number): boolean => Number.isInteger(pid) && !alive(pid);

/**
 * Keeps a second snapseq off this run: `<run>.lock` holding this pid, created with `wx`. A lock whose process
 * is gone is taken over: moved to a name of its own first, so of two processes taking it over only one gets
 * it, and checked again there. Removed by the returned function, or when this process exits, and never by another.
 */
export function lockRun(cacheFile: string): () => void {
  const lock = cacheFile.replace(/\.json$/, ".lock");
  mkdirSync(dirname(lock), { recursive: true });
  const busy = (pid: number): Error =>
    new Error(`snapseq: another snapseq${Number.isInteger(pid) ? ` (pid ${pid})` : ""} is writing this run; its lock is ${lock}`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } catch (err) {
        // Ours and empty (a disk full, say): left, it would read as busy forever. Nobody takes over an empty lock.
        try {
          closeSync(fd);
        } catch {}
        rmSync(lock, { force: true });
        throw err;
      }
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = pidIn(lock);
      if (attempt > 0 || !stale(pid)) throw busy(pid);
      const moved = `${lock}.${randomUUID()}`;
      try {
        renameSync(lock, moved);
      } catch {
        continue; // another process took it over first: creating ours fails below unless it let go again
      }
      const now = pidIn(moved);
      if (!stale(now)) {
        // A live lock replaced the stale one before the move: put it back, unless a newer one is there already.
        // ponytail: a third process can create a lock in the instant this one is moved away; a lock directory would close that.
        try {
          linkSync(moved, lock);
        } catch {}
        rmSync(moved, { force: true });
        throw busy(now);
      }
      rmSync(moved, { force: true });
    }
  }
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
    } catch {}
  };
  process.once("exit", release);
  return () => {
    process.off("exit", release);
    release();
  };
}

export function loadCache(file: string): RunCache {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as RunCache;
    if (data?.version === 1 && data.entries && typeof data.entries === "object") return data;
  } catch {}
  return { version: 1, entries: {} };
}

/** Temp file, then rename: a reader never sees half a cache. */
export function saveCache(file: string, cache: RunCache): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(temp, file);
}

/** The cached capture of `key` when it can stand in for a shoot: same origin as now, every shot still a file. */
export function reusable(cache: RunCache, key: string, now: Origin): CachedCapture | undefined {
  const entry = Object.hasOwn(cache.entries, key) ? cache.entries[key] : undefined;
  if (
    !entry ||
    entry.configFile !== now.configFile ||
    entry.sequencesDir !== now.sequencesDir ||
    entry.sequenceFile !== now.sequenceFile ||
    entry.screenshotsDir !== now.screenshotsDir ||
    !Array.isArray(entry.capture?.shots)
  ) {
    return undefined;
  }
  return entry.capture.shots.every((s) => typeof s?.path === "string" && isFile(s.path)) ? entry.capture : undefined;
}
