---
"snapseq": minor
---

Sequence filter words are globs over sequence ids, in a plain run and in a repair alike.

A word is matched against the whole id (the sequence file's path in `sequencesDir` without `.seq.ts`, with `/` on every platform) with Node's `path.matchesGlob`, case-sensitively. `snapseq cll/dosing` selects exactly `cll/dosing`, `snapseq 'cll/*'` every sequence directly in `cll/`, `snapseq 'wm/**'` everything under `wm/`, nested folders too, and `snapseq '*'` the top-level sequences. Several words select the union; no word still runs everything. Quote every glob: stock zsh stops on an unquoted one that matches nothing, and a shell expands one that matches files in the working directory, which snapseq refuses with `snapseq: cll/dosing.md is not a sequence file; quote a glob so the shell leaves it` (for a file inside `sequencesDir` it adds the glob over ids to quote, like `: 'cll/*'`). A sequence file works as its id, and only its own, so tab completion does: `snapseq snapseq/cll/dosing.seq.ts`; in a repair it selects the part of that file.

Breaking changes, and what to write instead:

- A plain run's word was Playwright's file filter, a case-insensitive regular expression over absolute paths, so `snapseq cll` also selected a folder `cll/` and `cll/**` crashed with `Invalid regular expression`. `snapseq cll` is now `snapseq 'cll/*'` and `snapseq dosing` is `snapseq cll/dosing`. A regular expression or `file:line` goes after `--`, which still hands everything to Playwright as given: `snapseq -- 'dosing\.seq'`; those filters add files to the ones the words select.
- A repair's word (`snapseq -o x --run r <word>`) was a substring of the sequence id. It is a glob over the id now: `12346` becomes `'12346*'`.
- Case matters in both: `Cll/*` selects nothing.
- A plain run's word that selects no sequence stops with exit 1 before Playwright starts and before `--run` takes its lock and drops the run's cache, naming what it may have meant (`snapseq: no sequence matches "cll"`, then `cll is a folder: 'cll/*' selects its 3 sequences`, or `did you mean cll/dosing?`). A plain run with words now reads `snapseq.config.ts` in the snapseq command to list the sequences. In a repair the check stays at the end, because a `run()` can point at another `sequencesDir`: each sequence word that matched no part, even when another word matched, fails the run with `no part matched "<word>"` and the same hints, after the file and its steps have run. A leading `!` selects nothing, Node's `!(cll)/**` included. A word that only differs in case says `case matters: it would select cll/dosing`.
- `--record 0` with a space reads `0` as a sequence word: it stops with `no sequence matches "0"` unless a sequence is named `0`, and then it records that one. Write `--record=0`.
- Node `^20.17.0 || >=22.5.0` (`path.matchesGlob`); Node 20 prints its ExperimentalWarning when a glob is used.
