# snapseq-pdf

A [snapseq](https://github.com/syantra/snapseq/tree/main/packages/snapseq)
plugin that writes one PDF per capture and device from the shots that capture
took. One page per shot, in shot order, each page the size of its image.

## Install

In the app that has snapseq. Peer dependency: `snapseq`.

```bash
pnpm add -D snapseq-pdf
```

## Config

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { pdf } from "snapseq-pdf";

export default defineConfig({ envs: { /* … */ }, plugins: [pdf()] });
```

## Use

No option: take the shots as usual; the PDF follows once the capture passes.

```ts
// captures/home.capture.ts
capture(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snap();      // page 1
  await seq.snapPage();  // page 2
});
```

## What it writes

One PDF per device, next to the device folder and named after it:

```
.screenshots/2026-10-01 at 04.07.16 PM/home/desktop/01.png
.screenshots/2026-10-01 at 04.07.16 PM/home/desktop.pdf
.screenshots/2026-10-01 at 04.07.16 PM/home/mobile/01.png
.screenshots/2026-10-01 at 04.07.16 PM/home/mobile.pdf
```

With `snapseq-label` in `plugins`, the labels are on the pages, in either order.

## Limits

- A page is the shot's CSS size, at 0.75 pt per CSS px: a 2x phone shot gives
  a phone-sized page with the full 2x image on it.
- A very tall full-page shot is one very tall page; some PDF viewers dislike them.
- Only for a capture that passed. A rerun removes the previous PDF first.

More: [Plugins](https://github.com/syantra/snapseq/blob/main/packages/snapseq/docs/plugins.md), on how they run and how to write one.
