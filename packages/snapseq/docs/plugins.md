# Plugins

A plugin acts on the shots a sequence takes: a label strip above each image, a
PDF of the whole sequence, a page that holds still for the shot. It is a small
object listed in the config's `plugins`. Three ship as their own packages;
writing one takes a few lines.

## Using plugins

Install what you use, in the app that has snapseq:

```bash
pnpm add -D @snapseq/label @snapseq/pdf @snapseq/stabilize
```

All three peer-depend on `snapseq`. `label` and `pdf` work on the shot files,
not in a browser, so any Playwright browser will do. `stabilize` works in the
page through `ctx.page`, in `begin`, `beforeSnap`, `afterGrow` and `afterSnap`, and is
tested on Chromium. List them in the config:

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { label } from "@snapseq/label";
import { pdf } from "@snapseq/pdf";

export default defineConfig({
  envs: { dev: { host: "http://localhost:3000" } },
  plugins: [label(), pdf()],
});
```

`plugins` is empty by default. Hooks run in the order the plugins are listed.

| Package                                 | Adds                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@snapseq/label`](../../label/README.md) | A `label` option on `snap` and `snapPage`: a strip with that text above the shot, styled and scaled from the config. |
| [`@snapseq/pdf`](../../pdf/README.md)     | One PDF per sequence and device, a page per shot.                                           |
| [`@snapseq/stabilize`](../../stabilize/README.md) | Freezes viewport-height units so `snapPage` works on `100vh` pages, keeps fixed elements where the first screen had them in `snapPage` (`floating`), fires a scroll event after the grow (`scrollEvent`), stops motion before each shot, moves the pointer off the content (`hover`), and can scroll a native full page first (`scroll`). |

A sequence asks a plugin for something through the shot's options:

```ts
// snapseq/home.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snap({ label: "0.0 Home" });   // 01.png, 24 px taller
});
```

A plugin with no per-shot options, like `pdf`, needs nothing in the sequence.

## Writing a plugin

A plugin is an object. A function that returns it is the usual shape, so the
config reads `plugins: [names()]`.

```ts
interface Plugin {
  name: string;
  /** The page exists; the sequence body has not run. */
  begin?(ctx: SequenceContext): Promise<void>;
  /** Start of `snap` and `snapPage`. No file yet. May edit `shot.options` and push to `shot.notes`. */
  beforeSnap?(shot: Shot, ctx: SequenceContext): Promise<void>;
  /** In `snapPage`, each time the viewport has grown, before the readiness wait. */
  afterGrow?(shot: Shot, ctx: SequenceContext): Promise<void>;
  /** After the file is written. May rewrite it in place. */
  afterSnap?(shot: Shot, ctx: SequenceContext): Promise<void>;
  /** After the sequence passed, with every shot of it, in order. */
  done?(shots: readonly Shot[], ctx: SequenceContext): Promise<void>;
  /** After the sequence failed, with the shots listed so far. */
  failed?(shots: readonly Shot[], ctx: SequenceContext): Promise<void>;
}
```

Every field but `name` is optional. `Plugin` and `Shot` are exported from
`snapseq`.

A `Shot` is one screenshot, still to be taken in `beforeSnap` and written in
`afterSnap`:

| Field     | Value                                                                                         |
| --------- | --------------------------------------------------------------------------------------------- |
| `name`    | The file name, e.g. `01.png`.                                                                 |
| `path`    | The absolute path of the file.                                                                |
| `url`     | The page URL when the shot was taken. In `beforeSnap`, the URL when the snap started.         |
| `index`   | The position in the sequence, from 1.                                                          |
| `options` | What the sequence passed to `snap` or `snapPage`, plugin keys included. `beforeSnap` may edit it. |
| `notes`   | The shot's notes, printed with it in the terminal: what `beforeSnap` hooks pushed, then the readiness notes, e.g. `2 images still loading after 5 s (first: …)`. In `beforeSnap`, what earlier hooks pushed. |
| `format`  | The config's `format`. `{}` is PNG.                                                           |
| `deviceScaleFactor` | The file's pixels per CSS pixel, e.g. `2` on a 2x phone, `1` for a shot with `scale: "css"`. The device option's ratio, the page's `devicePixelRatio` as a fallback when the option is unset (the default desktop device), read once at the first shot and clamped to 0.1 to 16. Provisional in `beforeSnap`, as a hook may still set `scale`. |

`name`, `path`, `index` and `format` belong to snapseq: a hook must not
change them.

### Hooks

Hooks run in the worker, inside the sequence. Every hook is optional. Hooks of
every kind run in the order the plugins are listed, each awaited.

| Hook                    | Runs                                                                                                      | Gets                    | Can do                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `begin(ctx)`            | In the `seq` fixture, once the page exists and before the sequence body.                                    | `ctx`                   | Cookies, headers, init scripts, routes, viewport, `emulateMedia`, persistent CSS, through `ctx.page` and `ctx.page.context()`. |
| `beforeSnap(shot, ctx)` | At the start of `snap` and `snapPage`, before the readiness wait and before `snapPage` grows the viewport. | `shot`, no file yet     | Change the page, edit `shot.options` (`mask`, `clip`, `style`, `omitBackground`, …), push to `shot.notes`.             |
| `afterGrow(shot, ctx)`  | In `snapPage`, each time the viewport has grown (to the document height, and again if the height changed), before the readiness wait and the height measure. | `shot`, no file yet | Settle what the grow started, at the grown viewport.                                                    |
| `afterSnap(shot, ctx)`  | After the file is written.                                                                                  | `shot`, file on disk    | Rewrite the file in place.                                                                                              |
| `done(shots, ctx)`      | In teardown, only when the sequence body passed.                                                            | Every shot, in order    | Write beside the shots.                                                                                                 |
| `failed(shots, ctx)`    | In teardown, when the body failed or timed out, after `failed.png` was attempted.                          | The shots listed so far | Write beside the shots.                                                                                                 |

A sequence runs hooks only if it uses `seq` or `ctx`. One that uses neither has
no `seq` and runs none. `seq` is not an auto fixture on purpose: a sequence
skipped by a file-level `skipIf` then gets no directory.

- **`begin`** runs before the body's first line, so what it sets up is there
  for it.
  - It cannot change what a context is created with: user agent, device scale
    factor, `isMobile`, locale and timezone belong in the env's `use` or the
    device config.
  - The env's `replay` routes are registered before `begin` runs, and
    Playwright runs the most recently registered route first. A plugin route
    that should leave `replay` reachable calls `route.fallback()`, not
    `route.continue()`.
  - A `begin` that throws fails the sequence before its body. There is no
    `failed.png` and no `failed` hook: the fixture never reaches teardown.
- **`beforeSnap`** runs for every `snap` and `snapPage` once the current
  document is parsed, before the readiness wait and before `snapPage` grows
  the viewport, so what it changes on the page is settled and measured. A
  document it navigates to is not waited for that way. It runs for shots
  that carry none of the plugin's options too, so check your own key first and
  return.
  - Push to `shot.notes` to put a note on the shot's line. The hooks' notes
    come first, in order, then the readiness notes. Each is cleaned (control,
    format and line-separator characters to spaces, trimmed, at most 200
    characters) and listed once.
  - Edit `shot.options` to change the screenshot. The config's `format` (type
    and quality) and the numbered path always win over anything in it, and a
    `fullPage` set on a `snapPage` shot is dropped.
  - A `clip` computed from layout before the viewport grows can be stale on
    `snapPage`: prefer `mask` with locators. CSS that changes layout belongs
    on the page (`addStyleTag`, `addPersistentStyle`), not in the screenshot
    `style` option, which applies after the height was measured.
  - A shot refused or failed before its screenshot, such as a `snapPage` height
    refusal or a throwing `beforeSnap`, gives its number back.
- **`afterGrow`** runs at the grown viewport, only in `snapPage`: a plugin
  that must settle something the grow started (a reveal an observer fired, a
  handler that follows the scroll) goes here, so the readiness wait and the
  height measure that follow see the result. It does not run when the
  viewport is restored.
- **`afterSnap`** runs once the file is written, before the terminal counts it.
  A shot counts, and joins `seq.shots`, once every plugin's `afterSnap` has
  passed. It runs for shots that carry none of the plugin's options too, so
  check your own key first and return.
  - `shot.deviceScaleFactor` is now the file's: `1` when the options set
    `scale: "css"`.
  - A throwing `afterSnap` leaves the file on disk, but the shot is not
    added to `seq.shots`, and the hooks after it do not run.
- **`done`** runs once, only when the sequence body passed, with every shot of
  this sequence and device in order. It runs before the page closes, in its
  own step named after the plugin. A sequence that used `seq` but took no shot
  gets an empty list. Every `afterSnap` has run by then, so `done` sees the
  files as the `afterSnap` hooks left them, whatever the order in `plugins`.
- **`failed`** runs once, when the body failed or timed out, in its own step
  after `failed.png` was attempted. `failed.png` is in `ctx.seq.dir` when the
  page could be shot; it is not in `shots`.

`done` and `failed` each get the sequence's timeout; one that runs longer fails
the sequence. A throw in `done` does not run `failed`.

A hook that throws fails the sequence, naming the plugin and the hook:

```
snapseq: plugin "auth" threw in begin: <message>
snapseq: plugin "label" threw in afterSnap on 01.png: <message>
snapseq: plugin "pdf" threw in done: <message>
```

`beforeSnap` names the shot like `afterSnap`; `failed` reads like `done`.

### Adding an option

A plugin reads its key from `shot.options`. Playwright ignores the screenshot
keys it does not know, so the key reaches `page.screenshot` harmlessly.

To type the key, add it to `SnapOptions` with a module augmentation, in the
plugin's source:

```ts
declare module "snapseq" {
  interface SnapOptions {
    label?: string;
  }
}
```

The augmentation applies to a TypeScript program that includes the plugin's
types. The config's import does that when the sequences and the config share a
`tsconfig.json`. Otherwise a sequence file needs
`/// <reference types="@snapseq/label" />` or an import of its own. Playwright
does not typecheck sequences, so a missing augmentation shows in your editor and
in `tsc`, not in a run.

### Factories are pure

Playwright evaluates the config, and so the factories, in every process it
starts: the main process and each worker. Each gets its own instances, so an
instance is not shared and must not hold state across sequences. Read what you
need from the hook's arguments and write to disk. State across the shots of
one sequence can live in a `WeakMap` keyed by `ctx.seq`.

### An example

A plugin that appends each shot's name to `names.txt` beside the shots:

```ts
// names.ts
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "snapseq";

export function names(): Plugin {
  return {
    name: "names",
    async afterSnap(shot, ctx) {
      await appendFile(join(ctx.seq.dir, "names.txt"), `${shot.name}\n`);
    },
  };
}
```

```ts
// snapseq.config.ts
plugins: [names()],
```

`pricing/desktop/names.txt` then reads `01.png`, `02.png`. The sequence's
directory is wiped when the sequence starts, so a rerun starts the file over.

## What a hook can reach

`ctx` is a `SequenceContext`, with the same fields as the `ctx` fixture:

| Field    | Value                                                |
| -------- | ---------------------------------------------------- |
| `page`   | The sequence's Playwright page.                       |
| `seq`    | The handle for this sequence.                        |
| `env`    | The active env name, e.g. `"dev"`.                   |
| `host`   | The resolved base URL.                               |
| `device` | The `devices` key this run is on, e.g. `"mobile"`.   |

- `ctx.seq.dir` is the directory of this sequence and device. Write what the
  plugin makes there.
- `ctx.seq.shots` lists the shots so far, in order, each one's hooks passed.
  In `beforeSnap` and `afterSnap` the current shot is not in it yet.

`beforeSnap` and `afterSnap` run in the middle of the sequence. Take no shot of
your own from either: one shot runs at a time, and a `seq.snap()` from a hook
throws. Leave `ctx.page` as you found it in `afterSnap`; `beforeSnap` changes
it on purpose. Work on the file, as `label` and `pdf` do, rather than in a
browser of your own.
