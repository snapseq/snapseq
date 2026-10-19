---
"snapseq": patch
---

A slow image on a page with no web fonts is noted as an image wait, not a font wait (the font note now reads `font readiness still pending after 5 s`), and a screenshot that fails, such as a timeout on a page held by an image that never answers, carries the readiness notes in its error. `SNAPSEQ_OPEN=0` keeps the file manager closed after an interactive run, and the terminal warning has one space after `taken with`.
