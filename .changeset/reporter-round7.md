---
"snapseq": patch
---

The live terminal view on a short terminal: the running row is always in view, and below 7 rows it prints one line per event instead of a frame that was taller than the screen and pushed lines into scrollback. "Where it died" keeps the last real page when the teardown's page is `about:blank` or `chrome-error://`, as after a failed navigation. A long capture label or path is cut from the left, so the shot count, clock and the end of the URL keep their columns. A terminal resize during the dev-server wait no longer glues the header onto the waiting line. Ctrl-C no longer opens the file manager on the abandoned run directory. Latin letters with diacritics in a capture name (`über-uns`) show as they are in the live view instead of `?`; wider scripts still show `?`.
