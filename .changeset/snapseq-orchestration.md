---
"snapseq": minor
---

Orchestration files, stabilize built in, and the plugin system removed.

- A file named `*.orchestration.ts` runs sequences in an order you choose, with settings you choose for each, and works on the shots they take. Its default export is `defineOrchestration(async ({ run, config, dir }) => { … })`. `run(sequence, options, ...playwright)` shoots one sequence in its own Playwright process and resolves to one `Capture` per device. Start it with `snapseq <file>.orchestration.ts`. `defineOrchestration` and the types `Capture`, `CaptureShot`, `RunOptions`, `ResolvedSnapseqConfig`, `Orchestration` and `OrchestrationContext` are exported. snapseq now depends on `jiti`, which loads the config and the orchestration file.
- `--run <name>` names the run folder, the same as `SNAPSEQ_RUN`. With an orchestration file, sequence words and `--device` after it shoot those parts again and take the rest from the run's cache in `node_modules/.cache/snapseq/runs`, then every step runs again. A plain run with `--run <name>` drops that run's cache.
- `stabilize` is a config key, on by default: `stabilize: false` turns it off, and an object switches single steps (`viewportUnits`, `floating`, `scrollEvent`, `motion`, `hover`, `scroll`, `reducedMotion`). `@snapseq/stabilize` is merged into snapseq. A config that listed no `stabilize()` now gets it: `snapPage` takes a `100vh` page, motion stops and the pointer leaves the content before each shot. `StabilizeOptions` is exported, and `snap({ hover: "keep" })` is typed by snapseq itself.
- The plugin system is gone: `plugins`, the `Plugin` and `Shot` types and the `snapseq` Playwright option are removed. `@snapseq/label` and `@snapseq/pdf` are steps now, called from an orchestration file. Playwright's `outputDir` moves to `node_modules/.cache/snapseq/playwright`.

Migrate a 0.6 config: drop `plugins` and the `@snapseq/stabilize` import and dependency, and move any option you passed to `stabilize()` into the `stabilize` key. Move `label()` and `pdf()` into an orchestration file; a plain `snapseq` run now takes raw shots only, with no labelled files and no PDFs. Page setup that was a plugin's `begin` hook goes in the sequence or in a Playwright fixture.
