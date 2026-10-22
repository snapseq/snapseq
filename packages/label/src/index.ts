import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Capture, CaptureShot } from "snapseq";

export interface LabelStyle {
  /** `"light"` is a white strip with black text, the default. `"dark"` is the opposite. */
  theme?: "light" | "dark";
  /** A color librsvg reads: a named color, hex or `rgb()`. Overrides the theme's. */
  background?: string;
  /** A color librsvg reads: a named color, hex or `rgb()`. Overrides the theme's. */
  color?: string;
}

export interface LabelOptions extends LabelStyle {
  /**
   * `true`: the strip follows the shot's device scale factor, so it reads the same at 1x and 4x.
   * A function maps the factor to the strip's scale, e.g. `(dsf) => Math.max(1, dsf / 2)`.
   * Default: the strip is 24 px of the file at any scale.
   */
  scale?: boolean | ((deviceScaleFactor: number) => number);
}

declare module "snapseq" {
  interface SnapOptions {
    /** Text for the strip above this shot, or the text with a style of its own; no strip without it. The strip is drawn by the `label` step of `@snapseq/label` in an orchestration, not at capture time. */
    label?: string | ({ text: string } & LabelStyle);
  }
}

// The strip is drawn over a transparent extension, so the image area keeps its
// alpha: a transparent shot (omitBackground) stays transparent.
const STRIP = 24;
const THEMES = {
  light: { background: "#fff", color: "#000" },
  dark: { background: "#000", color: "#fff" },
};
// XML 1.0 rejects most control characters and lone surrogates, and librsvg fails the whole parse on one: a space instead.
const esc = (s: string) =>
  s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff\ud800-\udfff]/gu, " ")
    .replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

// The colors one level sets: its theme, then its own background and color over it.
const pick = ({ theme, background, color }: LabelStyle) => ({
  ...(theme && THEMES[theme]),
  ...(background ? { background } : {}),
  ...(color ? { color } : {}),
});

// The width of the text's ink: render it alone on a canvas one pixel wider than the image, then trim.
// Ink that reaches the right edge does not fit, so a longer canvas is never needed.
async function inkWidth(text: string, size: number, height: number, y: number, width: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 1}" height="${height}"><text x="0" y="${y}" text-anchor="start" font-family="sans-serif" font-size="${size}">${esc(text)}</text></svg>`;
  return (await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true })).info.width;
}

// One shot into `file`: the strip above it when `options.label` is set, a plain copy when not.
async function labelShot(shot: CaptureShot, file: string, options: LabelOptions) {
  const spec = typeof shot.options.label === "string" ? { text: shot.options.label } : shot.options.label;
  if (!spec?.text) return copyFile(shot.path, file);
  const { text } = spec;
  const colors = { ...THEMES.light, ...pick(options), ...pick(spec) };
  const { scale } = options;
  const s = scale === true ? shot.deviceScaleFactor : typeof scale === "function" ? scale(shot.deviceScaleFactor) : 1;
  if (!(Number.isFinite(s) && s > 0)) throw new Error(`@snapseq/label: scale must be a positive number, got ${s}`);
  if (Math.round(STRIP * s) < 1) throw new Error(`@snapseq/label: scale ${s} makes a strip under 1 px`);
  const [height, size, y, inset] = [Math.round(STRIP * s), 12 * s, 16 * s, 8 * s];
  const img = sharp(shot.path);
  const { width, hasAlpha } = await img.metadata();
  // Centered if it fits with the inset on both sides; else from the inset, so the end is cut and the start is not.
  const fits = (await inkWidth(text, size, height, y, width)) + 2 * inset <= width;
  const place = fits ? 'x="50%" text-anchor="middle"' : `x="${inset}" text-anchor="start"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${esc(colors.background)}"/><text ${place} y="${y}" font-family="sans-serif" font-size="${size}" fill="${esc(colors.color)}">${esc(text)}</text></svg>`;
  const out = img
    .extend({ top: height, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  // The extension is RGBA; an RGB shot goes back to RGB, or the PNG comes out up to 4x bigger on flat pages.
  if (!hasAlpha) out.removeAlpha();
  // optimiseCoding (sharp's default) holds the whole compressed image: a 3840x60000 shot peaked at 1.6 GB,
  // and 1920x34198 at 527 MB against 141 MB without it. The file is under 1% bigger.
  const encoded = shot.format.type === "jpeg" ? out.jpeg({ quality: shot.format.quality, optimiseCoding: false }) : out.png();
  await encoded.toFile(file);
}

/**
 * Every shot of every capture into `<capture.dir>/labelled/<name>`: a strip above the shots whose
 * `options.label` is set, a plain copy for the rest, so the labelled set is complete. The raw shots are
 * not touched. Resolves to new captures, with `dir` and every shot's `path` pointing at the labelled files.
 */
export async function label(captures: readonly Capture[], options: LabelOptions = {}): Promise<Capture[]> {
  const labelled: Capture[] = [];
  // One shot at a time: a tall shot holds hundreds of MB in sharp.
  for (const capture of captures) {
    const dir = join(capture.dir, "labelled");
    await mkdir(dir, { recursive: true });
    const shots: CaptureShot[] = [];
    for (const shot of capture.shots) {
      const path = join(dir, shot.name);
      await labelShot(shot, path, options);
      shots.push({ ...shot, path });
    }
    labelled.push({ ...capture, dir, shots });
  }
  return labelled;
}
