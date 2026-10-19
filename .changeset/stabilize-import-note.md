---
"@snapseq/stabilize": patch
---

A stylesheet that stays unreadable, such as a cross-origin `@import` of a font service's CSS, is fetched once per page load as text with CORS (3 s at most), and the `cannot read <url>: its viewport units stay live` note is kept only when that fails or the text has a viewport unit. `@font-face`-only CSS no longer puts the note on every shot.
