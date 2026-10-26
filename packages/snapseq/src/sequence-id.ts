// What names a sequence: its file, the id the screenshots folder and the orchestration use, the listing of a sequences
// folder, and the terminal row.
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/** A sequence file: `pricing.seq.ts`, or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. */
export const SEQUENCE_FILE = /\.seq\.[cm]?[jt]s$/;

/** An orchestration file: `spring.orchestration.ts`, or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`. */
export const ORCHESTRATION_FILE = /\.orchestration\.[cm]?[jt]s$/;

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

/** A file relative to the sequences folder, `nested/pricing.seq.ts`, as its id: `nested/pricing`, with `/` on every platform. */
const idOf = (file: string, pattern: RegExp): string => file.replace(pattern, "").split(sep).join("/");

/**
 * `snapseq/nested/pricing.seq.ts` → `nested/pricing`. A titled test or a `describe` block appends its titles, so two
 * "hero" tests in different describes never share (and wipe) one directory.
 * Both paths are made canonical first: Playwright reports the file through resolved symlinks (macOS /var →
 * /private/var) while testDir keeps the configured path, and a mismatch would make relative() escape the root.
 */
export function sequenceId(testDir: string, file: string, titles: readonly string[]): string {
  const id = idOf(relative(canonical(testDir), canonical(file)), SEQUENCE_FILE);
  return titles.length === 1 && titles[0] === DEFAULT_TITLE ? id : join(id, ...titles).split(sep).join("/");
}

/**
 * Every file under `dir` that `pattern` matches, relative and as the disk spells it, sorted, with its id. A folder that
 * cannot be read is skipped, not the whole listing; `node_modules` is skipped as Playwright skips it.
 */
function sequences(dir: string, pattern: RegExp, rel = ""): { file: string; id: string }[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => {
      const file = join(rel, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sequences(dir, pattern, file);
      return pattern.test(entry.name) ? [{ file, id: idOf(file, pattern) }] : [];
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Ids under `dir`, `nested/pricing` style, sorted; none when it cannot be read. Sequences, or the files `pattern` matches. */
export function sequenceIds(dir: string, pattern = SEQUENCE_FILE): string[] {
  return [...new Set(sequences(dir, pattern).map((s) => s.id))].sort();
}

/** The files of `id` (or of every one of several) under `dir` as the disk spells them: ids compared NFC, as macOS may keep names decomposed. */
export function sequenceFiles(dir: string, id: string | readonly string[], pattern = SEQUENCE_FILE): string[] {
  const wanted = new Set((typeof id === "string" ? [id] : id).map((i) => i.normalize("NFC")));
  return sequences(dir, pattern)
    .filter((s) => wanted.has(s.id.normalize("NFC")))
    .map((s) => join(dir, s.file));
}

// Filter words: what `snapseq cll/dosing`, `snapseq 'cll/*'` and a repair's `--run r1 'cll/*'` all select by.

/** What makes a word a glob; one without is an id, compared as it is. */
const GLOB = /[*?[\]{}()!+@]/;

const nfc = (s: string): string => s.normalize("NFC");

/**
 * Whether `word` selects `id`: the id itself, or when the word has a glob character a glob over the whole id (`cll/*`
 * the sequences in cll/, `wm/**` everything under wm/ nested too, `*` the top-level ones). Case matters on every
 * platform. Both are NFC, as macOS hands names over decomposed. `!` negates nothing: Node reads `!(cll)/**` as every
 * sequence outside cll/, so a word that starts with one is no glob and matches no id.
 */
export function matchSequence(id: string, word: string): boolean {
  return nfc(id) === nfc(word) || (!word.startsWith("!") && GLOB.test(word) && posix.matchesGlob(nfc(id), nfc(word)));
}

/**
 * The ids any word selects, plus the `exact` ones as they are (a sequence file's id, whatever characters it has), in
 * `ids`' order, and the words that select none.
 */
export function selectSequences(
  ids: readonly string[],
  words: readonly string[],
  exact: readonly string[] = [],
): { ids: string[]; misses: string[] } {
  const found = new Set(exact.map(nfc));
  const misses = new Set<string>();
  for (const word of words) {
    const hits = ids.filter((id) => matchSequence(id, word));
    if (hits.length === 0) misses.add(word);
    for (const id of hits) found.add(nfc(id));
  }
  return { ids: ids.filter((id) => found.has(nfc(id))), misses: [...misses] };
}

const count = (n: number): string => `${n} sequence${n === 1 ? "" : "s"}`;

/**
 * What to tell someone whose `word` selected nothing among `ids` (the sequences in `dir`): that it is a folder or an
 * orchestration, that only the case differs, the ids it may have meant, else every id. A substring is guessed only for a
 * word that is no folder or case slip.
 */
export function missHints(dir: string, ids: readonly string[], word: string): string[] {
  const w = nfc(word);
  const under = ids.filter((id) => nfc(id).startsWith(`${w}/`));
  const inside = under.filter((id) => !nfc(id).slice(w.length + 1).includes("/"));
  const named = ids.filter((id) => nfc(id).split("/").pop() === w);
  const cased = ids.filter((id) => matchSequence(nfc(id).toLowerCase(), w.toLowerCase()));
  const near = cased.length > 0 ? [] : named.length > 0 ? named : under.length > 0 ? [] : ids.filter((id) => nfc(id).toLowerCase().includes(w.toLowerCase()));
  const lines = [
    ...(under.length === 0 ? [] : [`${word} is a folder: ${inside.length > 0 ? `'${word}/*' selects its ${count(inside.length)}` : `'${word}/**' selects its ${count(under.length)}`}`]),
    ...(sequenceFiles(dir, word, ORCHESTRATION_FILE).length === 0 ? [] : [`${word} is an orchestration: snapseq -o ${word}`]),
    ...(cased.length === 0 ? [] : [`case matters: it would select ${cased.slice(0, 5).join(", ")}`]),
    ...(near.length === 0 ? [] : [`did you mean ${near.slice(0, 5).join(", ")}?${named.length > 0 ? ` '**/${word}' selects every ${word}` : ""}`]),
  ];
  return lines.length > 0 ? lines : [`sequences: ${ids.join(", ") || "(none)"}`];
}

/**
 * A word that names a file is not a glob but what a shell made of one, or tab completion: a sequence file (of `dir`, or
 * of any folder with `anywhere`, where a run() may point elsewhere) comes back as its canonical path, any other file is
 * an error. A word that names no file comes back undefined.
 */
export function fileWord(word: string, dir: string, anywhere = false): string | undefined {
  const given = resolve(word);
  if (!statSync(given, { throwIfNoEntry: false })?.isFile()) return undefined;
  const file = canonical(given);
  const inside = within(canonical(dir), file);
  if (SEQUENCE_FILE.test(given) && (anywhere || inside)) return file;
  // The glob over ids that would have selected its neighbours, only where it is a folder of the sequences.
  const folder = relative(canonical(dir), dirname(file)).split(sep).join("/");
  const glob = inside ? `: '${folder === "" ? "*" : `${folder}/*`}'` : "";
  throw new Error(`snapseq: ${word} is not a sequence file; quote a glob so the shell leaves it${glob}`);
}

/**
 * A terminal row's label, the identity the screenshots folder uses: `nested/pricing / desktop`, then ` (uat)` when the
 * env is shown. The orchestration parent measures its parts with it, so the children's rows line up.
 */
export function rowLabel(sequence: string, device: string, env?: string): string {
  return `${sequence} / ${device}${env ? ` (${env})` : ""}`.normalize("NFC"); // macOS hands file names over decomposed
}
