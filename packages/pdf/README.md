# @snapseq/pdf

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
step that binds the shots of any captures into one PDF. It is a plain async
function you call from an orchestration file, after `run()` has taken the shots.

```ts
pdf(captures: readonly Capture[], file: string): Promise<string>
```

## Install

In the app that has snapseq. Peer dependency: `snapseq` 0.7 or later. Runtime
dependency: `@cantoo/pdf-lib` 2.11.

```bash
pnpm add -D @snapseq/pdf
```

## Use

Inside an orchestration file, hand it the captures `run()` gave you and the path
of the file to write. It resolves to that path.

```ts
// snapseq/spring.orchestration.ts
import { join } from "node:path";
import { defineOrchestration } from "snapseq";
import { pdf } from "@snapseq/pdf";

export default defineOrchestration(async ({ run, dir }) => {
  const captures = [
    ...(await run("12345-spring-launch")),
    ...(await run("12346-spring-offer")),
  ];

  await pdf(captures, join(dir, "spring.pdf"));
});
```

One PDF per device: group the captures yourself, then bind each group.

```ts
for (const device of new Set(captures.map((c) => c.device))) {
  await pdf(captures.filter((c) => c.device === device), join(dir, `${device}.pdf`));
}
```

To get the labels on the pages, bind what [`@snapseq/label`](https://github.com/snapseq/snapseq/tree/main/packages/label)
returns instead of the raw captures.

## What a page is

- One page per shot. Captures go in the order you pass them; inside a capture,
  the shots go in index order. Any captures in any order make one file.
- A page is the shot's CSS size at 0.75 pt per CSS px: the image's pixels divided
  by the shot's `deviceScaleFactor`. A 2x phone shot gives a phone-sized page with
  the full 2x image drawn over it.
- A page whose longer side would pass 14400 pt, the limit many readers (Acrobat
  among them) enforce, is scaled down to fit. The image keeps every pixel.
- PNG and JPEG shots both embed; a JPEG goes in as it is. `format: { type: "jpeg", quality: 80 }`
  in the config makes much smaller PDFs for long pages, at the cost of text
  crispness and transparency.

## What it writes

An earlier file at `file` is replaced whole, never half written; its folder is created.

## Limits

- An empty list, or captures with no shots, throws `@snapseq/pdf: nothing to bind`
  and writes nothing.
- A shot file that cannot be read throws, and nothing is written.
- A `file` that is one of the shots, however it is spelled and through a linked
  folder too, throws `@snapseq/pdf: file is one of the shots`
  and writes nothing, so a shot is never replaced by the PDF.
- A shot whose `deviceScaleFactor` is not a finite number above 0 throws, and
  nothing is written.
- It does not merge existing PDF files and has no cover page.
