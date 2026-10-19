---
"@snapseq/stabilize": minor
---

- Motion: animations are no longer removed with `animation: none`. They run, and before each shot, and in `snapPage` after each grow once the DOM is quiet, they are finished, or cancelled when they cannot finish. A `forwards` reveal (a bar chart that grows in) keeps its final state, and a section that opens as the grown viewport shows it is measured open instead of being cut off or refused. Finishing runs the page's `animationend` handlers, and Playwright plays an infinite animation it cancelled for a shot again afterwards.
- New `scrollEvent` option, off by default: a scroll event at the document, bubbling to the window, after `snapPage` grows the viewport and before each shot, for UI that follows scroll events only (a tray that hides at the page end). Needs snapseq's `afterGrow` hook.
- A stylesheet that stays unreadable, such as a cross-origin `@import` of a font service's CSS, is fetched once per page load as text with CORS (at most 10 a shot, 512 K characters each, 3 s in all). The `cannot read <url>: its viewport units stay live` note is dropped only for a `text/css` answer with no viewport unit, escape or `@import` outside comments, strings and `url()`; `@font-face`-only CSS no longer puts the note on every shot.
