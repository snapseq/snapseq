# @snapseq/stabilize

## 0.2.0

### Minor Changes

- d2b0fba: - Motion: animations are no longer removed with `animation: none`. They run, and before each shot, and in `snapPage` after each grow once the DOM is quiet, they are finished, or cancelled when they cannot finish. A `forwards` reveal (a bar chart that grows in) keeps its final state, and a section that opens as the grown viewport shows it is measured open instead of being cut off or refused. Finishing runs the page's `animationend` handlers, and Playwright plays an infinite animation it cancelled for a shot again afterwards.
  - New `scrollEvent` option, on by default: a scroll event at the document, bubbling to the window, after `snapPage` grows the viewport and again once it is restored, so the page is back in its viewport state for what the sequence does next (a tray the grow hid shows again before the sequence clicks it), for UI that follows scroll events only (a tray that hides on scroll once its inline counterpart is in view, a back-to-top button). A "bottom reached" handler that appends content on each event can keep the page growing, and `snapPage` then refuses it; `scrollEvent: false` turns the event off. Needs snapseq's `afterGrow` and `afterRestore` hooks, so the peer range is now `snapseq >=0.6.0`.
  - New `floating` option, on by default: in `snapPage`, a `position: fixed` element keeps the top it had at the device viewport instead of following its `bottom` inset to the end of the grown page (a promo drawer, a chat bubble, a cookie banner). Fixed elements that were off the screen or only partly on it, that the page moved out of view or placed itself (a dropdown under its trigger), that the grow resized, or whose position the override does not reach (a transformed ancestor, a `margin: auto` dialog) are left alone, and the page's own inline `top` and `bottom` come back once the viewport is restored, whether the shot was taken or failed. `floating: false` turns it off.
  - A stylesheet that stays unreadable, such as a cross-origin `@import` of a font service's CSS, is fetched once per page load as text with CORS (at most 10 a shot, 512 K characters each, 3 s in all). The `cannot read <url>: its viewport units stay live` note is dropped only for a `text/css` answer with no viewport unit or escape outside comments, strings and `url()`, whose `@import`s (one level down, each counting toward the 10) pass the same check (a sheet the limit ran out for is tried again at the next shot); `@font-face`-only CSS, and a font service's sheet that imports an empty beacon sheet, no longer put the note on every shot.

### Patch Changes

- Updated dependencies [d166f63]
  - snapseq@0.6.0

## 0.1.1

### Patch Changes

- dc7fda5: The README and the package description use snapseq 0.5's words: a capture is a sequence, and a note prints in the terminal rather than in `shots.txt`.
- Updated dependencies [dc7fda5]
  - snapseq@0.5.0

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
