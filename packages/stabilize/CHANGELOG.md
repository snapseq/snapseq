# @snapseq/stabilize

## 0.1.0

### Minor Changes

- f97ccd3: New plugin. `stabilize()` freezes viewport-height units to px before each shot, so `snapPage` takes a page with a `100vh` section instead of refusing it, and stops motion: no transitions or animations, Web Animations finished, SVG animations and video paused where they are. It moves the pointer off the content before each shot (`hover`, with `snap({ hover: "keep" })` to skip it for one shot). `scroll: true` scrolls the page from its top to its end before a native `fullPage` shot, so reveals on scroll and lazy loaders fire. `reducedMotion: true` emulates `prefers-reduced-motion: reduce`. `viewportUnits: false`, `motion: false` and `hover: false` switch the steps off.

### Patch Changes

- e79b4aa: Each package's `exports` now points `require` at `index.d.cts` and `import` at `index.d.ts`, so a CommonJS consumer on `module: node16` no longer gets TS1479.
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
