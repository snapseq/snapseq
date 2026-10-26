import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * image keeps every pixel. The file is written beside `file` under a name of its own and renamed
 * into place, and the parent directory is created. Throws when there is no shot to bind, when
 * `file` is one of the shots, or when a shot's `deviceScaleFactor` is not a positive number.
 */
export async function pdf(captures: readonly Capture[], file: string): Promise<string> {
  const shots = captures.flatMap((c) => [...c.shots].sort((a, b) => a.index - b.index));
  if (shots.length === 0) throw new Error("@snapseq/pdf: nothing to bind");
  // The entry rename() would replace, as the file system finds it: through linked folders and `..` after them, in any
  // spelling it takes for the name. A link there is replaced, not followed: it matters only when it is a shot's own
  // recorded path. Anything else is compared with the files the shots are. A file not there yet is no shot.
  const target = await lstat(file).catch(() => undefined);
  if (target) {
    const look = target.isSymbolicLink() ? lstat : stat;
    const ids = await Promise.all(shots.map((shot) => look(shot.path).then((s) => `${s.dev}:${s.ino}`, () => "")));
    if (ids.includes(`${target.dev}:${target.ino}`)) throw new Error("@snapseq/pdf: file is one of the shots");
  }

  const doc = await PDFDocument.create();
  for (const shot of shots) {
    const dsf = shot.deviceScaleFactor;
    if (!(Number.isFinite(dsf) && dsf > 0)) throw new Error(`@snapseq/pdf: deviceScaleFactor must be a positive number, got ${dsf}`);
    const bytes = await readFile(shot.path);
    const img = shot.format.type === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const pt = Math.min(0.75 / dsf, MAX_PT / Math.max(img.width, img.height));
    const page = doc.addPage([img.width * pt, img.height * pt]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    // embedPng/embedJpg keep the decoded image in memory until save(); embed() writes it
    // into the document now and drops the decoded pixels. The compressed streams stay in the
    // document until save, so memory still grows with the PDF, far less.
    await img.embed();
  }

  await mkdir(dirname(file), { recursive: true });
  // A name of its own and an exclusive create: two calls on one `file` never share a temporary file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, await doc.save(), { flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return file;
}
