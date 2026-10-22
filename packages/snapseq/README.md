<p align="center"><img src="https://raw.githubusercontent.com/snapseq/snapseq/main/assets/logo.svg" width="128" alt=""></p>

# snapseq

[![npm](https://img.shields.io/npm/v/snapseq)](https://www.npmjs.com/package/snapseq)

Playwright Test fixtures for scripted screenshot sequences. A sequence is a
Playwright test; snapseq adds numbered screenshots per run, sequence and
device, env and host selection, one project per device, a `snapseq`
command, and defaults suited to long sequential runs. Everything else is stock
Playwright: `--headed`, `--ui`, `--debug`, `--trace on`, reporters, the VS Code
extension.

Capture lives in `snapseq`: it takes the shots, and its `stabilize` setting, on by
default, holds the page still for each one (steady viewport units for `snapPage`,
no motion, the pointer off the content). What happens to the shots afterwards is
steps in an [orchestration file](docs/orchestration.md), which runs several
sequences in an order you choose: `@snapseq/label` puts a label strip above each
shot, and `@snapseq/pdf` binds shots into a PDF.

## Quick start

In the app that owns the pages:

```bash
pnpm add -D @playwright/test snapseq
pnpm exec playwright install chromium   # once per machine; under Node 26 run this with Node 22
```

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";

export default defineConfig({
  envs: { dev: { host: "http://localhost:3000" } },
});
```

`stabilize` is on without being listed. A page with a `100vh` section would make
`snapPage` refuse it (`the document grew …`); with `stabilize` the section keeps
its height, and motion stops and the pointer leaves the content before each shot.
`stabilize: false` turns it off ([Config](docs/config.md#stabilize)).

```ts
// snapseq/pricing.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/pricing");
  await seq.snap();      // 01.png  the viewport
  await seq.snapPage();  // 02.png  the whole page
});
```

```bash
pnpm snapseq
```

```
screenshots/2026-10-01 at 04.07.16 PM/pricing/desktop/01.png
screenshots/2026-10-01 at 04.07.16 PM/pricing/desktop/02.png
screenshots/2026-10-01 at 04.07.16 PM/pricing/mobile/01.png
screenshots/2026-10-01 at 04.07.16 PM/pricing/mobile/02.png
```

## Docs

| Page                                        | Answers                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | How do I get from an empty app to a PNG?                             |
| [Config](docs/config.md)                   | How do I set up envs, devices, the dev server, `stabilize`, Playwright options? |
| [Sequences](docs/sequences.md)             | How do I write a sequence that takes the right shot?                 |
| [Running](docs/running.md)                 | How do I run it, and what do the outputs and the terminal mean?      |
| [Orchestration](docs/orchestration.md)     | How do I run several sequences in one run, label the shots, bind a PDF per device, or shoot one part again? |
| [Examples](docs/examples.md)               | Complete sequence files, basic to complex.                            |
| [Troubleshooting](docs/troubleshooting.md) | Something looks wrong.                                               |

## Develop and release

The commands run at the workspace root: see
[Develop and release](https://github.com/snapseq/snapseq#develop-and-release).
`docs/` is the API reference; a public change updates it and gets a changeset.
