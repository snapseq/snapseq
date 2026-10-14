<p align="center"><img src="https://raw.githubusercontent.com/syantra/snapseq/main/assets/logo.svg" width="128" alt=""></p>

# snapseq

[![npm](https://img.shields.io/npm/v/snapseq)](https://www.npmjs.com/package/snapseq)

Playwright Test fixtures for scripted screenshot captures. A capture is a
Playwright test; snapseq adds numbered screenshots per run, capture and
device, env and host selection, one project per device, a `snapseq`
command, and defaults suited to long sequential runs. Everything else is stock
Playwright: `--headed`, `--ui`, `--debug`, `--trace on`, reporters, the VS Code
extension. [Plugins](docs/plugins.md) add to the shots: a label strip above
each one, or one PDF per capture.

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

```ts
// captures/pricing.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/pricing");
  await seq.snap();      // 01.png  the viewport
  await seq.snapPage();  // 02.png  the whole page
});
```

```bash
pnpm screenshot   # "screenshot": "snapseq" in package.json
```

```
.screenshots/2026-10-01 at 04.07.16 PM/pricing/desktop/01.png
.screenshots/2026-10-01 at 04.07.16 PM/pricing/desktop/02.png
.screenshots/2026-10-01 at 04.07.16 PM/pricing/mobile/01.png
.screenshots/2026-10-01 at 04.07.16 PM/pricing/mobile/02.png
```

## Docs

| Page                                        | Answers                                                              |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md) | How do I get from an empty app to a PNG?                             |
| [Config](docs/config.md)                   | How do I set up envs, devices, the dev server, Playwright options?   |
| [Captures](docs/captures.md)               | How do I write a capture that takes the right shot?                  |
| [Running](docs/running.md)                 | How do I run it, and what do the outputs and the terminal mean?      |
| [Plugins](docs/plugins.md)                 | How do I add a label strip or a PDF, or write a plugin?              |
| [Examples](docs/examples.md)               | Complete capture files, basic to complex.                            |
| [Troubleshooting](docs/troubleshooting.md) | Something looks wrong.                                               |

## Develop and release

The commands run at the workspace root: see
[Develop and release](https://github.com/syantra/snapseq#develop-and-release).
`docs/` is the API reference; a public change updates it and gets a changeset.
