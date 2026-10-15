# snapseq-label

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
