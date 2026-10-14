---
"snapseq-label": minor
---

`theme`, `background` and `color` style the strip, on the factory and per shot through `label: { text, ... }`; the shot's style wins over the factory's. `scale` is an opt-in, `true` or a function of the device scale factor, so the strip can follow the shot's scale. A label wider than the strip is cut at the end only.
