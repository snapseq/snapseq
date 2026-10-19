---
"snapseq": patch
---

`--record` treats a different method or request body at the same URL as a second request and stops instead of overwriting the replay file; the error now reads `matched a second request <method url>`. A replay file that is not valid JSON fails before the capture starts with `snapseq: replay file <file> is not JSON: <reason>`, instead of serving it to the page.
