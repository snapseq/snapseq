import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import type { Plugin } from "snapseq";

export interface LabelStyle {
  /** `"light"` is a white strip with black text, the default. `"dark"` is the opposite. */
  theme?: "light" | "dark";
  /** Any CSS color. Overrides the theme's. */
  background?: string;
  /** Any CSS color. Overrides the theme's. */
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
    /** Text for the strip above this shot, or the text with a style of its own; no strip without it. Needs `snapseq-label` in `plugins`. */
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
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

// The colors one level sets: its theme, then its own background and color over it.
const pick = ({ theme, background, color }: LabelStyle) => ({
  ...(theme && THEMES[theme]),
  ...(background ? { background } : {}),
  ...(color ? { color } : {}),
});

// The width of the text's ink: render it alone on a canvas too wide to clip, then trim.
async function inkWidth(text: string, size: number, height: number, y: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(text.length * size * 2)}" height="${height}"><text x="0" y="${y}" text-anchor="start" font-family="sans-serif" font-size="${size}">${esc(text)}</text></svg>`;
  return (await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true })).info.width;
}

/** A strip above each shot that passes `label`, with the label centered. White with black text unless styled. */
export function label(options: LabelOptions = {}): Plugin {
  return {
    name: "label",
    async afterSnap(shot) {
      const spec = typeof shot.options.label === "string" ? { text: shot.options.label } : shot.options.label;
      if (!spec?.text) return;
      const { text } = spec;
      const colors = { ...THEMES.light, ...pick(options), ...pick(spec) };
      const { scale } = options;
      const s = scale === true ? shot.deviceScaleFactor : typeof scale === "function" ? scale(shot.deviceScaleFactor) : 1;
      const [height, size, y, inset] = [Math.round(STRIP * s), 12 * s, 16 * s, 8 * s];
      const img = sharp(shot.path);
      const { width } = await img.metadata();
      // Centered if it fits with the inset on both sides; else from the inset, so the end is cut and the start is not.
      const fits = (await inkWidth(text, size, height, y)) + 2 * inset <= width;
      const place = fits ? 'x="50%" text-anchor="middle"' : `x="${inset}" text-anchor="start"`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${esc(colors.background)}"/><text ${place} y="${y}" font-family="sans-serif" font-size="${size}" fill="${esc(colors.color)}">${esc(text)}</text></svg>`;
      const out = img
        .extend({ top: height, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
      // sharp will not write over its own input, so encode to a buffer first.
      const encoded = shot.format.type === "jpeg" ? out.jpeg({ quality: shot.format.quality }) : out.png();
      await writeFile(shot.path, await encoded.toBuffer());
    },
  };
}
