# @snapseq/label

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
step that puts a labeled strip above each screenshot. Pass `label` to
`seq.snap` or `seq.snapPage` in a sequence. In the orchestration file, run
`label()` over the captures: every shot gets a copy with a strip with that text
centered in it, white with black text unless you style it. A shot without
`label` gets a plain copy, so the labelled set is complete.

## Install

In the app that has snapseq. Peer dependency: `snapseq` 0.7 or later. Runtime
dependency: `sharp` 0.35.

```bash
pnpm add -D @snapseq/label
```

## Use

Label in the sequence:

```ts
// snapseq/home.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snap({ label: "0.0 Home" });      // 01.png
  await seq.snapPage({ label: "0.1 Full" });  // 02.png
  await seq.snap({ label: { text: "0.2 Dark", theme: "dark" } });  // 03.png, its own style
});
```

Run the step in the orchestration:

```ts
// snapseq/spring.orchestration.ts
import { defineOrchestration } from "snapseq";
import { label } from "@snapseq/label";

export default defineOrchestration(async ({ run }) => {
  const raw = [
    ...(await run("12345-spring-launch", { devices: ["desktop"] })),
    ...(await run("12346-spring-offer", { env: "uat" })),
  ];

  const labelled = await label(raw, { theme: "dark", scale: (dsf) => dsf / 2 });   // <capture.dir>/labelled/01.png …
});
```

A PDF per device over the labelled shots is in the
[Orchestration example](https://github.com/snapseq/snapseq/blob/main/packages/snapseq/docs/orchestration.md#an-example).

`label` in `seq.snap` is the text, or an object with the text and a style of
its own (`theme`, `background`, `color`). A shot's style wins over the step's.

`label` is typed once the package's types are in your TypeScript program. The
orchestration file's import does that when it and the sequences share a
`tsconfig.json`; otherwise add `/// <reference types="@snapseq/label" />` to
the sequence file.

## Options

```ts
label(captures)                              // white strip, black text
label(captures, { theme: "dark" })           // black strip, white text
label(captures, { scale: true })             // the strip follows the device scale factor
label(captures, { scale: (dsf) => dsf / 2 }) // the strip's scale from the factor
```

`background` and `color` win over the theme. They must be colors librsvg
understands: named colors, hex and `rgb()`. An unknown color draws black.

## Where files go

For each capture, `label` writes `<capture.dir>/labelled/<shot name>`, e.g.
`screenshots/review-1/12345-spring-launch/desktop/labelled/01.png` next to the
raw `01.png`. It creates `labelled/` and overwrites files already in it. The
raw shots are never changed.

It resolves to new captures, with `dir` and every shot's `path` pointing
at the labelled files, so the next step takes them as they are. Nothing else on
a capture or a shot changes. No captures in, none out, and nothing is written.

A shot with a label is one taller by the strip: 24 px times the scale, filled
with the resolved background, with 12 px times the scale system sans-serif text
in the resolved color, centered on one line, then the original image. Without
`scale`, a 1920 × 1080 shot becomes 1920 × 1104. The image is never resampled.
A shot without a label is copied byte for byte.

## Limits

- The label is text, on one line: HTML in it is shown as text, and a label
  wider than the strip is cut at the end.
- Without `scale`, the strip is 24 px of the file at any device scale factor,
  so on a 2x shot it reads as 12 CSS px. `scale: true` makes it follow the
  factor: 48 px on a 2x shot, 96 px on a 4x one. A function maps the factor to
  the scale instead, e.g. `scale: (dsf) => Math.max(1, dsf / 2)`. A scale that
  is not a finite number above 0, or is under 1/48 so the strip would be
  under 1 px, makes `label` throw.
- Shots are labelled one at a time. A failure stops the step; files already
  written stay in `labelled/`.
- A JPEG is decoded and encoded again at the shot's own quality.
- The text is drawn with a system font that fontconfig can find. A system with
  no fonts installed draws each character as a box, so install one there, e.g.
  `fonts-dejavu-core` on a Debian or Ubuntu image.
- Control characters and lone surrogates in a label are drawn as spaces.
- Color emoji may render as monochrome or solid shapes in the SVG path the
  strip uses (sharp through librsvg), so keep them out of a label.
