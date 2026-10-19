---
"snapseq-stabilize": minor
---

New plugin. `stabilize()` freezes viewport-height units to px before each shot, so `snapPage` takes a page with a `100vh` section instead of refusing it, and stops motion: no transitions or animations, Web Animations finished, SVG animations and video paused where they are. It moves the pointer off the content before each shot (`hover`, with `snap({ hover: "keep" })` to skip it for one shot). `scroll: true` scrolls the page from its top to its end before a native `fullPage` shot, so reveals on scroll and lazy loaders fire. `reducedMotion: true` emulates `prefers-reduced-motion: reduce`. `viewportUnits: false`, `motion: false` and `hover: false` switch the steps off.
