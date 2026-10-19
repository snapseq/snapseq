# @snapseq/pdf

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
plugin that writes one PDF per sequence and device from the shots that sequence
took. One page per shot, in shot order, each page the shot's CSS size.

## Install

In the app that has snapseq. Peer dependency: `snapseq`. Runtime dependency:
`@cantoo/pdf-lib` 2.11.

```bash
pnpm add -D @snapseq/pdf
```

## Config

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { pdf } from "@snapseq/pdf";

export default defineConfig({ envs: { /* … */ }, plugins: [pdf()] });
```

## Use

No option: take the shots as usual; the PDF follows once the sequence passes.

```ts
// snapseq/home.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snap();      // page 1
  await seq.snapPage();  // page 2
});
```

## What it writes

One PDF per device, next to the device folder and named after it:

```
screenshots/2026-10-01 at 04.07.16 PM/home/desktop/01.png
screenshots/2026-10-01 at 04.07.16 PM/home/desktop.pdf
screenshots/2026-10-01 at 04.07.16 PM/home/mobile/01.png
screenshots/2026-10-01 at 04.07.16 PM/home/mobile.pdf
```

With `@snapseq/label` in `plugins`, the labels are on the pages, in either order.

A page whose longer side would exceed 14400 pt, the limit many readers (Acrobat
among them) enforce, is scaled down to fit, and the image keeps every pixel.
`format: { type: "jpeg", quality: 80 }` in the config makes much smaller PDFs
for long pages, at the cost of text crispness and transparency (JPEGs are
embedded as they are).

## When the sequence fails

The shots listed so far go to `<device>.partial.pdf`, next to the device
folder, so a review can start from what was taken:

```
screenshots/2026-10-01 at 04.07.16 PM/home/desktop.partial.pdf
```

`failed.png` and a shot whose `afterSnap` threw are not in it. A sequence that
failed in `begin` or `done` writes no partial PDF.

## Limits

- A page is the shot's CSS size, at 0.75 pt per CSS px: a 2x phone shot gives
  a phone-sized page with the full 2x image on it.
- A sequence with no shots writes no PDF, partial or not. A rerun removes the
  previous PDF and partial PDF first.

More: [Plugins](https://github.com/snapseq/snapseq/blob/main/packages/snapseq/docs/plugins.md), on how they run and how to write one.
