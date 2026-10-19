# snapseq

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
