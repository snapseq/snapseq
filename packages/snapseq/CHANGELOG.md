# snapseq

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
