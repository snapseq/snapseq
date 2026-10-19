---
"snapseq": minor
---

Plugins get two hooks for `snapPage`. `afterGrow(shot, ctx)` runs each time the viewport has grown (to the document height, and again if the height changed), before the readiness wait and the height measure: a plugin that must settle something the grow started, such as a reveal an observer fired or a handler that follows the scroll, does it there. `afterRestore(shot, ctx)` runs once the viewport and the scroll position are back, after the shot was taken or after it failed: a plugin puts the page back in its viewport state there, so what the sequence does next sees it. Every plugin's `afterRestore` runs, then the first error is thrown: after a shot that was taken it fails the sequence, and after one that failed it is swallowed.

`snapPage` also measures a page that got shorter once the viewport grew. `scrollHeight` never reads below the viewport, so the second measure said "unchanged" and the shot ended in white rows under the footer; when it reads unchanged, the content's own bottom (the boxes, fixed elements left out, never more than `scrollHeight` or less than the device's viewport) is read too, and the viewport grows again to it.

docs: the troubleshooting entry for an element that fades in no longer says `stabilize()` sets `animation: none`.
