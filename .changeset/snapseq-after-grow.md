---
"snapseq": minor
---

Plugins get an `afterGrow(shot, ctx)` hook: in `snapPage`, each time the viewport has grown (to the document height, and again if the height changed), before the readiness wait and the height measure. A plugin that must settle something the grow started, such as a reveal an observer fired or a handler that follows the scroll, does it there.
