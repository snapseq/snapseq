---
"snapseq": minor
---

A capture is now a sequence, and the words follow the package name.

- `captures/` is `snapseq/`, and `capturesDir` is `sequencesDir` (default `"snapseq"`). Helpers, replay files and sessions live there too.
- `pricing.capture.ts` is `pricing.seq.ts`.
- `capture()` is `sequence()`; `CaptureContext`, `CaptureArgs` and `CaptureFn` are `SequenceContext`, `SequenceArgs` and `SequenceFn`.
- The output folder is `screenshots/`, with no leading dot. `screenshotsDir` keeps its name.
- `shots.txt` is no longer written. A shot's URL is on its step line, and a readiness or plugin note prints with it in the terminal as `snapseq: 03.png taken with <notes>  <url>`.
- A sequence whose directory another sequence file writes into (`home.seq.ts` on `mobile` beside `home/mobile.seq.ts`) is refused before the wipe, found from the file layout rather than from a marker file.
- Run it as `pnpm snapseq`; no npm script is needed.

Migrate: rename the folder and the files, replace the import and the function name, and drop the dot from any path that points into the output folder.
