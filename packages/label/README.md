# snapseq-label

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
plugin that puts a labeled strip above a screenshot. Pass `label` to
`seq.snap` or `seq.snapPage` and the shot gets a strip with that text centered
in it, white with black text unless you style it. A shot without `label` is
left alone.

## Install

In the app that has snapseq. Peer dependency: `snapseq`. Runtime dependency:
`sharp` 0.35.

```bash
pnpm add -D snapseq-label
```

## Config

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { label } from "snapseq-label";

export default defineConfig({ envs: { /* … */ }, plugins: [label()] });
```

The factory takes the style for every shot:

```ts
label()                    // white strip, black text
label({ theme: "dark" })   // black strip, white text
label({ scale: true })     // the strip follows the device scale factor
```

`background` and `color` win over the theme. They must be colors librsvg
understands: named colors, hex and `rgb()`. An unknown color draws black.

## Use

```ts
// captures/home.capture.ts
import { capture } from "snapseq";

capture(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snap({ label: "0.0 Home" });      // 01.png, with the strip
  await seq.snapPage({ label: "0.1 Full" });  // 02.png, with the strip
  await seq.snap({ label: { text: "0.2 Dark", theme: "dark" } });  // 03.png, its own style
});
```

`label` is the text, or an object with the text and a style of its own
(`theme`, `background`, `color`). A shot's style wins over the factory's.

`label` is typed once the package's types are in your TypeScript program. The
config's import does that when the config and the captures share a
`tsconfig.json`; otherwise add `/// <reference types="snapseq-label" />` to
the capture file.

## What it writes

The shot's file is replaced by one taller by the strip: 24 px times the scale,
filled with the resolved background, with 12 px times the scale system
sans-serif text in the resolved color, centered on one line, then the original
image. Without `scale`, a 1920 × 1080 shot becomes 1920 × 1104. The image is
never resampled. The file is rewritten in place.

## Limits

- The label is text, on one line: HTML in it is shown as text, and a label
  wider than the strip is cut at the end.
- Without `scale`, the strip is 24 px of the file at any device scale factor,
  so on a 2x shot it reads as 12 CSS px. `scale: true` makes it follow the
  factor: 48 px on a 2x shot, 96 px on a 4x one. A function maps the factor to
  the scale instead, e.g. `scale: (dsf) => Math.max(1, dsf / 2)`. A scale that
  is not a finite number above 0 throws.
- A JPEG is decoded and encoded again at the configured `format` quality.
- The text is drawn with a system font that fontconfig can find. A system with
  no fonts installed draws each character as a box, so install one there, e.g.
  `fonts-dejavu-core` on a Debian or Ubuntu image.
- Control characters and lone surrogates in a label are drawn as spaces.
- Color emoji may render as monochrome or solid shapes in the SVG path the
  strip uses (sharp through librsvg), so keep them out of a label.

More: [Plugins](https://github.com/snapseq/snapseq/blob/main/packages/snapseq/docs/plugins.md), on how they run and how to write one.
