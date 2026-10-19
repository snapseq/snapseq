import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Plugin, Shot } from "snapseq";

// The PDF sits next to the device folder and takes its name: <run>/home/desktop.pdf.
// After a failed sequence it is <run>/home/desktop.partial.pdf.
const file = (dir: string, partial = false) => join(dirname(dir), `${basename(dir)}${partial ? ".partial" : ""}.pdf`);

// Many readers (Acrobat) refuse a page longer than 14400 pt on a side.
const MAX_PT = 14400;

async function build(shots: readonly Shot[], dir: string, partial: boolean) {
  if (shots.length === 0) return;
  const doc = await PDFDocument.create();
  for (const shot of shots) {
    const bytes = await readFile(shot.path);
    const img = shot.format.type === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    // The page is the shot's CSS size at 0.75 pt per CSS px, so a 2x phone shot
    // gives a phone-sized page with the full 2x image drawn over it. A page whose
    // longer side would pass MAX_PT is scaled down to fit; the image keeps every pixel.
    const pt = Math.min(0.75 / shot.deviceScaleFactor, MAX_PT / Math.max(img.width, img.height));
    const page = doc.addPage([img.width * pt, img.height * pt]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    // embedPng/embedJpg keep the decoded image in memory until save(); embed() writes it
    // into the document now and drops the decoded pixels. The compressed streams stay in the
    // document until save, so memory still grows with the PDF, far less than before.
    await img.embed();
  }
  await writeFile(file(dir, partial), await doc.save());
}

/** One PDF per sequence and device, one page per shot at its CSS size, next to the device folder. */
export function pdf(): Plugin {
  return {
    name: "pdf",
    // A rerun wipes the device folder, not the PDFs beside it.
    begin: async (ctx) => {
      await rm(file(ctx.seq.dir), { force: true });
      await rm(file(ctx.seq.dir, true), { force: true });
    },
    done: (shots, ctx) => build(shots, ctx.seq.dir, false),
    failed: (shots, ctx) => build(shots, ctx.seq.dir, true),
  };
}
