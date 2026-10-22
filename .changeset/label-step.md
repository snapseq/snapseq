---
"@snapseq/label": minor
---

`label()` is now a step over captures, run from an orchestration file: `label(captures, options)` writes a `labelled/` folder next to the raw shots and returns the captures pointing at it. Every shot is there, with its strip when `snap()` was given a `label` and as a plain copy when not; the raw shots are never changed. The plugin form is gone, so `label()` no longer goes in `plugins`. It needs snapseq 0.7 or later.
