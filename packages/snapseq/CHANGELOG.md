# snapseq

## 0.7.0

### Minor Changes

- 5d561a2: Sequence filter words are globs over sequence ids, in a plain run and in a repair alike.
  
  A word is matched against the whole id (the sequence file's path in `sequencesDir` without `.seq.ts`, with `/` on every platform) with Node's `path.matchesGlob`, case-sensitively. `snapseq cll/dosing` selects exactly `cll/dosing`, `snapseq 'cll/*'` every sequence directly in `cll/`, `snapseq 'wm/**'` everything under `wm/`, nested folders too, and `snapseq '*'` the top-level sequences. Several words select the union; no word still runs everything. Quote every glob: stock zsh stops on an unquoted one that matches nothing, and a shell expands one that matches files in the working directory, which snapseq refuses with `snapseq: cll/dosing.md is not a sequence file; quote a glob so the shell leaves it` (for a file inside `sequencesDir` it adds the glob over ids to quote, like `: 'cll/*'`). A sequence file works as its id, and only its own, so tab completion does: `snapseq snapseq/cll/dosing.seq.ts`; in a repair it selects the part of that file. Spelled in another case than the disk's, it selects no id and stops like any word that selects nothing; a link named like a sequence file to a file that is no sequence file is refused as any other file.
  
  Breaking changes, and what to write instead:
  
  - A plain run's word was Playwright's file filter, a case-insensitive regular expression over absolute paths, so `snapseq cll` also selected a folder `cll/` and `cll/**` crashed with `Invalid regular expression`. `snapseq cll` is now `snapseq 'cll/*'` and `snapseq dosing` is `snapseq cll/dosing`. A regular expression or `file:line` goes after `--`, which still hands everything to Playwright as given: `snapseq -- 'dosing\.seq'`; those filters add files to the ones the words select.
  - A repair's word (`snapseq -o x --run r <word>`) was a substring of the sequence id. It is a glob over the id now: `12346` becomes `'12346*'`.
  - Case matters in both: `Cll/*` selects nothing.
  - A plain run's word that selects no sequence stops with exit 1 before Playwright starts and before `--run` takes its lock and drops the run's cache, naming what it may have meant (`snapseq: no sequence matches "cll"`, then `cll is a folder: 'cll/*' selects its 3 sequences`, or `did you mean cll/dosing?`). A plain run with words now reads `snapseq.config.ts` in the snapseq command to list the sequences. In a repair the check stays at the end, because a `run()` can point at another `sequencesDir`: each sequence word that matched no part, even when another word matched, fails the run with `no part matched "<word>"` and the same hints, after the file and its steps have run. A leading `!` selects nothing, Node's `!(cll)/**` included. A word that only differs in case says `case matters: it would select cll/dosing`.
  - `--record 0` with a space reads `0` as a sequence word: it stops with `no sequence matches "0"` unless a sequence is named `0`, and then it records that one. Write `--record=0`.
  - Node `^20.17.0 || >=22.5.0` (`path.matchesGlob`); Node 20 prints its ExperimentalWarning when a glob is used.
- 6e621fd: `snapseq -o <name>` runs an orchestration by name: `-o spring` is `snapseq/spring.orchestration.ts` and `-o wm/proof` is `snapseq/wm/proof.orchestration.ts`, the file's path in the config's `sequencesDir` without `.orchestration.ts`. `--orchestration <name>` and `--orchestration=<name>` work too. It counts only as the first argument, and everything after it reads as it does after a file: `--run`, sequence words, `--device`, `-c`. A name with no file, and a `-o` with no name, stop with the orchestrations found; two files for one name, a name that leaves the folder and a `-o` together with a file stop with a message of their own. The reshoot hint after a full run prints `-o <name>` when the run started that way. Giving the file works as before.
- 8cff50f: Orchestration files, stabilize built in, and the plugin system removed.
  
  - A file named `*.orchestration.ts` runs sequences in an order you choose, with settings you choose for each, and works on the shots they take. Its default export is `defineOrchestration(async ({ run, config, dir }) => { … })`. `run(sequence, options, ...playwright)` shoots one sequence in its own Playwright process and resolves to one `Capture` per device. Start it with `snapseq <file>.orchestration.ts`. `defineOrchestration` and the types `Capture`, `CaptureShot`, `RunOptions`, `ResolvedSnapseqConfig`, `Orchestration` and `OrchestrationContext` are exported. snapseq now depends on `jiti`, which loads the config and the orchestration file. The config must come from a snapseq 0.7 the command can talk to; otherwise the orchestration stops before any sequence runs and asks for one version for both.
  - `--run <name>` names the run folder, the same as `SNAPSEQ_RUN`. With an orchestration file, sequence words and `--device` after it shoot those parts again and take the rest from the run's cache in `node_modules/.cache/snapseq/runs`, then every step runs again. A plain run with `--run <name>` or `SNAPSEQ_RUN` drops that run's cache, and stops with `another snapseq … is writing this run` while another snapseq writes into it. After a full run, a `reshoot one part` hint repeats the command with its `--env` and `--host`; after one that ended on a failed child, a `resume:` line names the part that failed by its sequence file. An error the file, a step or the config throws ends with where it was thrown in your files, like `(spring.orchestration.ts:14)`.
  - `--env <name>` without `--host` now drops an inherited `SNAPSEQ_HOST`, so the run goes to that env's own host; `SNAPSEQ_ENV` alone still keeps it. In a plain run, `--` ends snapseq's own flags as it ends Playwright's: what follows goes to Playwright as given. `-c` also takes the config's folder.
  - `stabilize` is a config key, on by default: `stabilize: false` turns it off, and an object switches single steps (`viewportUnits`, `floating`, `scrollEvent`, `motion`, `hover`, `scroll`, `reducedMotion`). `@snapseq/stabilize` is merged into snapseq. A config that listed no `stabilize()` now gets it: `snapPage` takes a `100vh` page, motion stops and the pointer leaves the content before each shot. Over the 0.6 plugin, motion is stopped in open shadow roots too (an animation there ran on while `snapPage` measured, and the shot was refused or cut off), and a `)` inside a quoted `url("…")` no longer lets a `vh` after it in the URL be rewritten. `StabilizeOptions` is exported, and `snap({ hover: "keep" })` is typed by snapseq itself.
  - The plugin system is gone: `plugins`, the `Plugin` and `Shot` types, `seq.shots`, `SequenceArgs`, `SequenceFn`, `ShotFormat` and the `snapseq` Playwright option are removed. A sequence's shots reach an orchestration as the `Capture` that `run()` resolves to; `CaptureShot.format` is `{ type, quality? }`. `@snapseq/label` and `@snapseq/pdf` are steps now, called from an orchestration file. Playwright's `outputDir` moves to `node_modules/.cache/snapseq/playwright`.
  
  A 0.6 config with `plugins` stops with `snapseq: plugins were removed in 0.7; stabilize is the "stabilize" key, label() and pdf() are steps in an orchestration file`. Migrate it: drop `plugins` and the `@snapseq/stabilize` import and dependency, and move any option you passed to `stabilize()` into the `stabilize` key. Move `label()` and `pdf()` into an orchestration file; a plain `snapseq` run now takes raw shots only, with no labelled files and no PDFs. Page setup that was a plugin's `begin` hook goes in the sequence, as a function of yours that it awaits first, or in a Playwright `use` option such as `storageState`.

## 0.6.0

### Minor Changes

- d166f63: Plugins get two hooks for `snapPage`. `afterGrow(shot, ctx)` runs each time the viewport has grown (to the document height, and again if the height changed), before the readiness wait and the height measure: a plugin that must settle something the grow started, such as a reveal an observer fired or a handler that follows the scroll, does it there. `afterRestore(shot, ctx)` runs once the viewport and the scroll position are back, after the shot was taken or after it failed: a plugin puts the page back in its viewport state there, so what the sequence does next sees it. Every plugin's `afterRestore` runs, then the first error is thrown: after a shot that was taken it fails the sequence, and after one that failed it is swallowed.
  
  `snapPage` also measures a page that got shorter once the viewport grew. `scrollHeight` never reads below the viewport, so the second measure said "unchanged" and the shot ended in white rows under the footer; when it reads unchanged, the content's own bottom (the boxes, fixed elements left out, never more than `scrollHeight` or less than the device's viewport) is read too, and the viewport grows again to it. If the page then reads taller than that (the boxes missed overflowing text), the viewport goes back to the height that measured stable and the shot is taken there, not refused.
  
  docs: the troubleshooting entry for an element that fades in no longer says `stabilize()` sets `animation: none`.

## 0.5.0

### Minor Changes

- dc7fda5: A capture is now a sequence, and the words follow the package name.
  
  - `captures/` is `snapseq/`, and `capturesDir` is `sequencesDir` (default `"snapseq"`). Helpers, replay files and sessions live there too.
  - `pricing.capture.ts` is `pricing.seq.ts`.
  - `capture()` is `sequence()`; `CaptureContext`, `CaptureArgs` and `CaptureFn` are `SequenceContext`, `SequenceArgs` and `SequenceFn`.
  - The output folder is `screenshots/`, with no leading dot. `screenshotsDir` keeps its name.
  - `shots.txt` is no longer written. A shot's URL is on its step line, and a readiness or plugin note prints with it in the terminal as `snapseq: 03.png taken with <notes>  <url>`.
  - A sequence whose directory another sequence file writes into (`home.seq.ts` on `mobile` beside `home/mobile.seq.ts`) is refused before the wipe, found from the file layout rather than from a marker file.
  - Run it as `pnpm snapseq`; no npm script is needed.
  
  Migrate: rename the folder and the files, replace the import and the function name, and drop the dot from any path that points into the output folder.

## 0.4.0

### Minor Changes

- e79b4aa: A shot waits for the current document to be parsed (`DOMContentLoaded`) before the plugin hooks and the readiness wait, so a shot right after a click that navigates sees the whole new page; a page that never finishes parsing holds it to the navigation timeout, so navigate before the shot, not from a hook. `snapPage` puts the scroll position back after the shot, into the same document only. A page about one screen tall whose content scrolls inside an element, open shadow roots included, is not grown: it is shot at the device's viewport, with a note naming the element, and a shell that grows with the viewport gets the note instead of a refusal. A plain `snap` waits only for the visible images in the viewport (or the `clip`) and above it, one at `opacity: 0` included; a full page still waits for all of them. Image notes name the first image (`N images still loading after 5 s (first: <url>)`, the URL without its credentials, query or hash), a broken image that is shown gets `N images failed to load (first: <url>)`, and the DOM note names the element that changed most. Notes a `beforeSnap` hook pushes to `shot.notes` reach `shots.txt` and the terminal, before the readiness notes, and a `snapPage` refusal lists them. `shot.deviceScaleFactor` comes from the device's option rather than the page, and is `1` from `afterSnap` on for a shot with `scale: "css"`. `--record=0` and `--record=false` replay instead of recording, and `--record` refuses a second URL that would overwrite the same replay file in one device's run. An empty device name is refused, and the reporter drops control and format characters from error text.
- e79b4aa: A self-signed https dev server passes the `webServer` readiness check. `--record` refuses a non-2xx status or a non-JSON body before writing, and leaves the existing replay file. `SNAPSEQ_RECORD` takes `1`/`true` or `0`/`false`/empty and rejects anything else. `host` must be an http(s) URL. The final terminal summary lists only the rows that ran, were skipped or were interrupted; the footer still counts every row. `metadata.snapseq` is restored after an override brings its own `metadata`. `--ui`, `--ui-host` and `--ui-port` get the list reporter, like `--list` and `--debug`. The CLI runs the Playwright installed beside the config, so `snapseq -c apps/web/snapseq.config.ts` works from a monorepo root.

### Patch Changes

- e79b4aa: `--record` treats a different method or request body at the same URL as a second request and stops instead of overwriting the replay file; the error now reads `matched a second request <method url>`. A replay file that is not valid JSON fails before the capture starts with `snapseq: replay file <file> is not JSON: <reason>`, instead of serving it to the page.
- e79b4aa: A slow image on a page with no web fonts is noted as an image wait, not a font wait (the font note now reads `font readiness still pending after 5 s`), and a screenshot that fails, such as a timeout on a page held by an image that never answers, carries the readiness notes in its error. `SNAPSEQ_OPEN=0` keeps the file manager closed after an interactive run, and the terminal warning has one space after `taken with`.
- e79b4aa: `snapPage` waits for images again after it grows the viewport a second time, so an image that a newly shown section starts loading is in the shot or noted; a slow page can then spend two 5 s image budgets in one `snapPage`. A page whose `html` has `overflow-y: auto` and whose layout follows the viewport is now refused like any other, instead of being noted as scrolling inside `<html>`; a `body` with containment still counts as an inner scroller. `snap` no longer waits for an image that a scrolling panel or another overflow box cuts out of view: the check follows the containing-block chain (a fixed image, or an absolute one whose containing block is outside the box, is not cut) and keeps any image it cannot be sure of. The image wait adds one load and one error listener per image and removes them when it ends. A capture whose directory holds another capture's output, a subdirectory with a `shots.txt` (`home.capture.ts` on `mobile` and `home/mobile.capture.ts` on `desktop`), now fails with `snapseq: refusing to wipe …: it holds another capture's output (…)` and deletes nothing; any other subdirectory, such as one a hook wrote, is wiped as before.
- e79b4aa: `--record` treats a `FormData` POST sent twice as one request: a multipart body is compared with its delimiter lines normalized (the boundary is read from the `boundary` parameter of a `multipart/form-data` content type; field values are left alone), so the same form no longer fails as a second request, and the second-request error ends with `(the bodies differ)` when only the body changed. `failed.png` is written when an image in the initial HTML never answers: the teardown abandons pending images before its screenshot, `<picture>` sources and images in frames included (their `src` and `srcset` are removed, in the teardown only, never in a shot); the screenshot used to wait on the same load event and time out. `SNAPSEQ_OPEN=false` keeps the run directory closed like `0`, in any case. A readiness note keeps the `url`, `src` or `image` query parameter of an image served through a loader (`…/_next/image?url=/img/hero.jpg`): decoded, without its own query, hash or credentials (however they are encoded), left out when it is not an http(s) URL, and cut to 60 characters; every other parameter is still dropped. The troubleshooting entry for an image that never answers lists the fixes that work.
- e79b4aa: docs: a second sweep against the code; the replay section no longer suggests splitting same-URL POSTs by pattern, `SNAPSEQ_OPEN`, the two plugin notes and four error texts are documented, and the staging example uses `httpCredentials` rather than a token in `extraHTTPHeaders`.
- e79b4aa: Each package's `exports` now points `require` at `index.d.cts` and `import` at `index.d.ts`, so a CommonJS consumer on `module: node16` no longer gets TS1479.
- 691df8d: The repository moved to `github.com/snapseq/snapseq`; `repository`, `homepage` and `bugs` in each package point there.
- e79b4aa: The live terminal view on a short terminal: the running row is always in view, and below 7 rows it prints one line per event instead of a frame that was taller than the screen and pushed lines into scrollback. "Where it died" keeps the last real page when the teardown's page is `about:blank` or `chrome-error://`, as after a failed navigation. A long capture label or path is cut from the left, so the shot count, clock and the end of the URL keep their columns. A terminal resize during the dev-server wait no longer glues the header onto the waiting line. Ctrl-C no longer opens the file manager on the abandoned run directory. Latin letters with diacritics in a capture name (`über-uns`) show as they are in the live view instead of `?`; wider scripts still show `?`.
- e79b4aa: docs: the plugins page, the troubleshooting entry for a refused `snapPage`, and the captures and examples pages point at `@snapseq/stabilize` for pages with `100vh` sections.

## 0.3.0

### Minor Changes

- 9240f95: The default `numbering` is `"00"`: shots are `01.png`, `02.png`, … unless the config says otherwise. Set `numbering: "000"` to keep three digits.
- 2a1750c: `plugins` in the config takes addons such as `snapseq-label` and `snapseq-pdf`: `plugins: [label(), pdf()]`. A plugin is an object with a `name` and optional hooks: `begin` before the capture body, `beforeSnap` and `afterSnap` around each shot, `done` after a capture passed and `failed` after one failed. `beforeSnap` can edit the shot's options and `afterSnap` can rewrite the file. A hook that throws fails the capture. `seq.shots` lists the shots taken so far, and `shot.deviceScaleFactor` is the page's device pixels per CSS pixel. One shot runs at a time: a second `snap` before the first resolved throws.
- 9240f95: `format` in the config takes Playwright's screenshot `type` and `quality`: `{ type: "jpeg", quality: 60 }` writes `01.jpg`, `02.jpg`, … PNG stays the default.

### Patch Changes

- be86742: The run directory pads the hour to two digits (`2026-10-01 at 04.07.16 PM`).

## 0.2.0

### Minor Changes

- 7420641: `numbering` in the config sets the shape of a shot number: `"000"` (the default) gives `001.png`, `"0000"` gives `0001.png`.
- dd1ee01: `replay` on an env answers listed requests from recorded files before every capture, and `--record` (`SNAPSEQ_RECORD`) fetches them live and writes the files.

## 0.1.0

### Minor Changes

- Initial release. Playwright Test fixtures for scripted screenshot captures.
  - `capture()` files write numbered PNGs per run, capture and device, with `shots.txt` listing each file's URL.
  - `seq.snap()` for the viewport and `seq.snapPage()` for the whole page; both wait for the DOM to go quiet, fonts and images, and note on the shot when a wait ran out.
  - `defineConfig()` with envs and hosts, HTTP credentials scoped to the host's origin, per-env Playwright `use` options, a dev server command, one project per device, and Playwright overrides as extra arguments.
  - The `snapseq` command with `--env`, `--host` and `--device`; everything else goes to `playwright test`.
  - A live terminal view for interactive runs, `failed.png` beside the shots when a capture dies, and a run directory per run.
