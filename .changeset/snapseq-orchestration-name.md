---
"snapseq": minor
---

`snapseq -o <name>` runs an orchestration by name: `-o spring` is `snapseq/spring.orchestration.ts` and `-o wm/proof` is `snapseq/wm/proof.orchestration.ts`, the file's path in the config's `sequencesDir` without `.orchestration.ts`. `--orchestration <name>` and `--orchestration=<name>` work too. It counts only as the first argument, and everything after it reads as it does after a file: `--run`, sequence words, `--device`, `-c`. A name with no file, and a `-o` with no name, stop with the orchestrations found; two files for one name, a name that leaves the folder and a `-o` together with a file stop with a message of their own. The reshoot hint after a full run prints `-o <name>` when the run started that way. Giving the file works as before.
