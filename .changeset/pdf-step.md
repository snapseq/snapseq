---
"@snapseq/pdf": minor
---

`pdf()` is now a step over captures, run from an orchestration file: `pdf(captures, file)` binds any captures, in any order, into one file and resolves to `file`. The plugin form is gone, and so are the per-device `.pdf` and `.partial.pdf` that were written beside the shots folder. An empty list, or captures with no shots, throws `@snapseq/pdf: nothing to bind`.
