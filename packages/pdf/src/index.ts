import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Plugin } from "snapseq";

/** One PDF per capture and device, one page per shot at its own size, beside the shots. */
export function pdf(): Plugin {
  return {
    name: "pdf",
    async done(shots, ctx) {
      if (shots.length === 0) return;
      const doc = await PDFDocument.create();
      for (const shot of shots) {
        const bytes = await readFile(shot.path);
        const img = shot.format.type === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        // The page is the shot's CSS size at 0.75 pt per CSS px, so a 2x phone shot
        // gives a phone-sized page with the full 2x image drawn over it.
        const pt = 0.75 / shot.deviceScaleFactor;
        const page = doc.addPage([img.width * pt, img.height * pt]);
        page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      }
      await writeFile(join(ctx.seq.dir, `${basename(dirname(ctx.seq.dir))}.pdf`), await doc.save());
    },
  };
}
