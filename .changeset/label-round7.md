---
"snapseq-label": patch
---

A label with a control character or a lone surrogate no longer fails the capture; each is drawn as a space. A very long label no longer fails on the measuring canvas, which is now as wide as the image. An RGB shot stays RGB, so a flat page's PNG is not up to 4x bigger. A JPEG is re-encoded without `optimiseCoding`, which held the whole compressed image in memory (1.6 GB on a 3840 x 60000 shot) for a file under 1% smaller. A `scale` that is not a finite number above 0 now throws `snapseq-label: scale must be a positive number`.
