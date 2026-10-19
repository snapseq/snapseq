# @snapseq/label

## 0.2.1

### Patch Changes

- dc7fda5: The README and the package description use snapseq 0.5's words: a capture is a sequence, and a note prints in the terminal rather than in `shots.txt`.
- Updated dependencies [dc7fda5]
  - snapseq@0.5.0

## 0.2.0

### Minor Changes

- 974942d: Renamed: `snapseq-label` is now `@snapseq/label` and `snapseq-pdf` is now `@snapseq/pdf`. The old names are deprecated on npm and get no further releases.

### Patch Changes

- e79b4aa: Each package's `exports` now points `require` at `index.d.cts` and `import` at `index.d.ts`, so a CommonJS consumer on `module: node16` no longer gets TS1479.
- e587661: A label with a control character or a lone surrogate no longer fails the capture; each is drawn as a space. A very long label no longer fails on the measuring canvas, which is now as wide as the image. An RGB shot stays RGB, so a flat page's PNG is not up to 4x bigger. A JPEG is re-encoded without `optimiseCoding`, which held the whole compressed image in memory (1.6 GB on a 3840 x 60000 shot) for a file under 1% smaller. A `scale` that is not a finite number above 0 now throws `@snapseq/label: scale must be a positive number`.
- 691df8d: The repository moved to `github.com/snapseq/snapseq`; `repository`, `homepage` and `bugs` in each package point there.
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

- 2a1750c: Initial release. `label()` adds a white strip with a centered label above each shot that passes `label`: `seq.snap({ label: "0.0 Home" })`.
- 2a1750c: The strip is drawn with sharp as a file transform. No browser context is launched, and `@playwright/test` is no longer a peer dependency.
- 2a1750c: `theme`, `background` and `color` style the strip, on the factory and per shot through `label: { text, ... }`; the shot's style wins over the factory's. `scale` is an opt-in, `true` or a function of the device scale factor, so the strip can follow the shot's scale. A label wider than the strip is cut at the end only.

### Patch Changes

- Updated dependencies [9240f95]
- Updated dependencies [2a1750c]
- Updated dependencies [be86742]
- Updated dependencies [9240f95]
  - snapseq@0.3.0
