# Getting started

From an empty app to a screenshot. Every step here uses the defaults; the
other pages cover what to change.

## 1. Install

In the app that owns the pages. In a monorepo, each app gets its own install
and its own config.

```bash
pnpm add -D @playwright/test snapseq snapseq-stabilize
pnpm exec playwright install chromium
```

The browser install is once per machine. Under Node 26 it hangs; run it with
Node 22 (`nvm use 22`).

Without access to the registry, vendor it instead: run `pnpm build` in a
checkout, copy `dist/`, `README.md` and `package.json` (without `scripts`,
`devDependencies` and `files`) into the consumer, e.g. `vendor/snapseq`, and
depend on it with `"snapseq": "file:../../vendor/snapseq"`. Do the same for
`snapseq-stabilize`.

## 2. Add the script

```json
{
  "scripts": { "screenshot": "snapseq" }
}
```

## 3. Write the config

`snapseq.config.ts` beside `package.json`:

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { stabilize } from "snapseq-stabilize";

export default defineConfig({
  envs: {
    dev: { host: "http://localhost:3000", webServer: "pnpm dev" },
  },
  plugins: [stabilize()],
});
```

`host` is the base URL every capture navigates from. `webServer` is the
command that serves it: snapseq starts it before the run if nothing answers
at `host` yet, and stops it after. Leave `webServer` out to run against a
server you start yourself.

`stabilize()` is a plugin. Without it, a page with a `100vh` section makes
`snapPage` fail (`the document grew …`): the section grows with the viewport
and the page never settles. With it, the section keeps its height. The plugin
also stops motion and moves the pointer off the content before each shot.

Two devices come by default, `desktop` (1920 × 1080) and `mobile` (390 × 844
at 2x, touch). [Config](config.md#devices) covers changing them.

## 4. Write a capture

One file per capture in `captures/`. The file name is the capture name.

```ts
// captures/pricing.capture.ts
import { capture } from "snapseq";

capture(async ({ page, seq }) => {
  await page.goto("/pricing");  // relative to host
  await seq.snap();             // 01.png  the viewport
  await seq.snapPage();         // 02.png  the whole page
});
```

`page` is Playwright's. `seq` numbers the shots: `snap` is the viewport,
`snapPage` the whole page. Both wait for the page to be ready first: DOM quiet,
fonts in, images loaded. [Captures](captures.md) covers the other fixtures and
the waits.

## 5. Run

```bash
pnpm screenshot
```

Every capture runs on every device, one at a time. On a terminal, you see one
line per capture and device, updated in place as the run goes. When the run
ends, the run directory opens in a file manager window (Finder on macOS);
`SNAPSEQ_OPEN=0` keeps it closed. Piped, in CI or in an agent, or with
`--list`, `--debug`, `--ui`, `--ui-host`, `--ui-port`, `PWDEBUG` or
`TERM=dumb`, the output is Playwright's list reporter instead: it ends with a
count like `2 passed (4.9s)`, not the summary line below, and it does not
print the run directory or open a window.

```
  ✔ pricing / desktop  2 shots  3.1s
  ✔ pricing / mobile   2 shots  3.4s

  2 passed  4 shots  .screenshots/2026-10-01 at 04.07.16 PM
```

## 6. Find the shots

```
.screenshots/                          gitignored by snapseq itself
  2026-10-01 at 04.07.16 PM/            one directory per run, local time
    pricing/
      desktop/
        01.png
        02.png
        shots.txt                      one line per shot: file, URL, any notes
      mobile/
        01.png
        02.png
        shots.txt
```

The run is `.screenshots/<run>`, `<run>` being the time the run started. For
a script or CI, name it: `SNAPSEQ_RUN=nightly pnpm screenshot` writes
`.screenshots/nightly/`.

## Next

- One capture, one device, another env: [Running](running.md).
- A menu that opens, a tray that docks, a state that loads late: [Examples](examples.md).
- A shot that looks wrong: [Troubleshooting](troubleshooting.md).
