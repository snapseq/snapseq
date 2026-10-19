---
"snapseq": patch
---

`snapPage` fires a scroll event after it grows the viewport, and again once the viewport is restored, at the document and bubbling to the window as a real scroll does. UI that follows the scroll, such as a fixed tray that hides once the page end is in view, now settles the same way whether the sequence was scrolled to the top or not, and is back as it was for the next shot.
