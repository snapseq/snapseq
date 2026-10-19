# @snapseq/pdf

## 0.2.0

### Minor Changes

- 6d1f58e: A page whose longer side would pass 14400 pt, the limit many readers enforce, is scaled down to fit; the image keeps every pixel. A failed capture now writes the shots taken so far to `<device>.partial.pdf`, and a rerun removes it.
- 974942d: Renamed: `snapseq-label` is now `@snapseq/label` and `snapseq-pdf` is now `@snapseq/pdf`. The old names are deprecated on npm and get no further releases.

### Patch Changes

- e79b4aa: Each package's `exports` now points `require` at `index.d.cts` and `import` at `index.d.ts`, so a CommonJS consumer on `module: node16` no longer gets TS1479.
- 691df8d: The repository moved to `github.com/snapseq/snapseq`; `repository`, `homepage` and `bugs` in each package point there.
- 6d1f58e: Each shot is embedded in the PDF as soon as its page is drawn, so a long capture of tall pages no longer holds every decoded image in memory until the file is saved.
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
- Updated dependencies [691df8d]
- Updated dependencies [e79b4aa]
- Updated dependencies [e79b4aa]
  - snapseq@0.4.0

## 0.1.0

### Minor Changes

- 2a1750c: A page is the shot's CSS size, not its pixel size: a 2x phone shot gives a phone-sized page with the full 2x image on it, from `shot.deviceScaleFactor`.
- 2a1750c: Initial release. `pdf()` writes one PDF per capture and device next to the device folder, one page per shot at the shot's own size, e.g. `<run>/home/desktop.pdf`.
- 2a1750c: The PDF is built from the shot files with pdf-lib. No browser: it works with any Playwright browser, and Playwright is no longer a peer dependency.

### Patch Changes

- Updated dependencies [9240f95]
- Updated dependencies [2a1750c]
- Updated dependencies [be86742]
- Updated dependencies [9240f95]
  - snapseq@0.3.0
