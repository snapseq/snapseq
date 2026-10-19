---
"snapseq": minor
---

Plugins get two hooks for `snapPage`. `afterGrow(shot, ctx)` runs each time the viewport has grown (to the document height, and again if the height changed), before the readiness wait and the height measure: a plugin that must settle something the grow started, such as a reveal an observer fired or a handler that follows the scroll, does it there. `afterRestore(shot, ctx)` runs once the viewport and the scroll position are back, after the shot was taken or after it failed: a plugin puts the page back in its viewport state there, so what the sequence does next sees it. A throw in it fails the sequence after a shot that was taken, and is swallowed after one that failed.

docs: the troubleshooting entry for an element that fades in no longer says `stabilize()` sets `animation: none`.
