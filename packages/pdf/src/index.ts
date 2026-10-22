import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Capture } from "snapseq";

// Many readers (Acrobat) refuse a page longer than 14400 pt on a side.
const MAX_PT = 14400;

/**
 * Binds the shots of `captures` into one PDF at `file` and resolves to `file`. One page per
 * shot: captures in the order given, shots in index order within each. A page is the shot's
 * CSS size at 0.75 pt per CSS px, so a 2x phone shot gives a phone-sized page with the full 2x
 * image drawn over it. A page whose longer side would pass 14400 pt is scaled down to fit; the
 * image keeps every pixel. The file is written beside `file` and renamed into place, and the
 * parent directory is created. Throws when there is no shot to bind.
 */
export async function pdf(captures: readonly Capture[], file: string): Promise<string> {
  const shots = captures.flatMap((c) => [...c.shots].sort((a, b) => a.index - b.index));
  if (shots.length === 0) throw new Error("@snapseq/pdf: nothing to bind");

  const doc = await PDFDocument.create();
  for (const shot of shots) {
    const bytes = await readFile(shot.path);
    const img = shot.format.type === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const pt = Math.min(0.75 / shot.deviceScaleFactor, MAX_PT / Math.max(img.width, img.height));
    const page = doc.addPage([img.width * pt, img.height * pt]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    // embedPng/embedJpg keep the decoded image in memory until save(); embed() writes it
    // into the document now and drops the decoded pixels. The compressed streams stay in the
    // document until save, so memory still grows with the PDF, far less than before.
    await img.embed();
  }

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, await doc.save());
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return file;
}
