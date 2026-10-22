// What names a sequence: its file, the id the screenshots folder and the orchestration use, the listing of a sequences
// folder, and the terminal row.
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A sequence file: `pricing.seq.ts`, or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. */
export const SEQUENCE_FILE = /\.seq\.[cm]?[jt]s$/;

/** The title `sequence()` gives its test: the file's one sequence, which adds nothing to the id. */
export const DEFAULT_TITLE = "sequence";

/**
 * The path with symlinks resolved. A path that does not exist yet (the screenshots folder before the first shot) is its
 * deepest existing ancestor resolved, then the rest as given: the same before and after it is created.
 */
export function canonical(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}

/** Whether `inner` is `outer` or inside it, by the paths alone: a folder named `..x` is inside. */
export function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Where the config's paths (the screenshots folder, replay files) resolve from: the config file's folder, else rootDir. */
export function configDirOf(config: { configFile?: string; rootDir: string }): string {
  return config.configFile ? dirname(config.configFile) : config.rootDir;
}

/** A sequence file relative to the sequences folder, `nested/pricing.seq.ts`, as its id: `nested/pricing`, with `/` on every platform. */
const idOf = (file: string): string => file.replace(SEQUENCE_FILE, "").split(sep).join("/");

/**
 * `snapseq/nested/pricing.seq.ts` → `nested/pricing`. A titled test or a `describe` block appends its titles, so two
 * "hero" tests in different describes never share (and wipe) one directory.
 * Both paths are made canonical first: Playwright reports the file through resolved symlinks (macOS /var →
 * /private/var) while testDir keeps the configured path, and a mismatch would make relative() escape the root.
 */
export function sequenceId(testDir: string, file: string, titles: readonly string[]): string {
  const id = idOf(relative(canonical(testDir), canonical(file)));
  return titles.length === 1 && titles[0] === DEFAULT_TITLE ? id : join(id, ...titles).split(sep).join("/");
}

/**
 * Every sequence file under `dir`, relative and as the disk spells it, sorted, with its id. A folder that cannot be
 * read is skipped, not the whole listing; `node_modules` is skipped as Playwright skips it.
 */
function sequences(dir: string, rel = ""): { file: string; id: string }[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => {
      const file = join(rel, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sequences(dir, file);
      return SEQUENCE_FILE.test(entry.name) ? [{ file, id: idOf(file) }] : [];
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Sequence ids under `dir`, `nested/pricing` style, sorted; none when it cannot be read. */
export function sequenceIds(dir: string): string[] {
  return [...new Set(sequences(dir).map((s) => s.id))].sort();
}

/** The files of `id` under `dir` as the disk spells them: ids compared NFC, as macOS may keep names decomposed. */
export function sequenceFiles(dir: string, id: string): string[] {
  return sequences(dir)
    .filter((s) => s.id.normalize("NFC") === id.normalize("NFC"))
    .map((s) => join(dir, s.file));
}

/**
 * A terminal row's label, the identity the screenshots folder uses: `nested/pricing / desktop`, then ` (uat)` when the
 * env is shown. The orchestration parent measures its parts with it, so the children's rows line up.
 */
export function rowLabel(sequence: string, device: string, env?: string): string {
  return `${sequence} / ${device}${env ? ` (${env})` : ""}`.normalize("NFC"); // macOS hands file names over decomposed
}
