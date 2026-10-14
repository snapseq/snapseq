---
"snapseq": minor
---

`plugins` in the config takes addons such as `snapseq-label` and `snapseq-pdf`: `plugins: [label(), pdf()]`. A plugin is an object with a `name` and optional hooks: `begin` before the capture body, `beforeSnap` and `afterSnap` around each shot, `done` after a capture passed and `failed` after one failed. `beforeSnap` can edit the shot's options and `afterSnap` can rewrite the file. A hook that throws fails the capture. `seq.shots` lists the shots taken so far, and `shot.deviceScaleFactor` is the page's device pixels per CSS pixel. One shot runs at a time: a second `snap` before the first resolved throws.
