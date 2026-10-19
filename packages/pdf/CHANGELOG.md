# @snapseq/pdf

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
