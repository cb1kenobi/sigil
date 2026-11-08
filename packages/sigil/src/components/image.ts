/**
 * An image: a picture fitted to the box layout gave it, drawn in half blocks.
 *
 * `Pixels` already paints one pixel across and two down per cell, with a colour
 * per half. What it could not do is take a picture: a caller had to work out
 * every pixel themselves. So this is three things in a row, each of them the
 * smallest that is right -- **fit** the picture to the box in pixels, which is
 * where a cell being about twice as tall as it is wide is accounted for;
 * **resample** it with a box filter, which `resampleImage()` in the canvas
 * module is; and **compose** each pixel over whatever is already in the cell it
 * lands in, at paint time, because only the grid knows that.
 *
 * It is a `raw`, because an image is the case the trapdoor was designed in for:
 * it is measured like a text and placed like one, and what goes in its box is
 * its own business. Not selectable, which is the default a `raw` has for exactly
 * this reason -- a wall of half blocks is nothing anybody wants in a clipboard.
 */

import { type Color, DEFAULT_COLOR, Pixels, resampleImage, rgb } from '../canvas/index.js';
import { type Element, raw, renderToString } from '../element/index.js';
import { assertRgbaImage, decodePng, type RgbaImage } from '../png/index.js';
import { colorRgb, quantizeColor } from '../style/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { terminalWidth } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';

/**
 * How a picture fills a box whose proportions are not its own.
 *
 * The three `object-fit` values that mean something without a natural size to
 * fall back on. `contain` shows all of it and leaves the rest of the box
 * showing through; `cover` fills the box and crops what does not fit, centred;
 * `fill` stretches it to the box, which is a distortion and is sometimes exactly
 * what a caller wants -- a texture, a background, a picture already the right
 * shape that a rounding should not letterbox by a row.
 */
export type ImageFit = 'contain' | 'cover' | 'fill';

/**
 * A picture: PNG bytes, decoded with `decodePng()`, or the RGBA a decoder of
 * the caller's own produced.
 *
 * Told apart by shape rather than by a flag, because the two cannot be confused:
 * a PNG is a byte array and RGBA is an object holding one. A `Buffer` from
 * `readFileSync()` is a `Uint8Array`, so a file read is a picture as it stands.
 */
export type ImageSource = RgbaImage | Uint8Array;

export interface ImageViewOptions {
  /** How the picture fills a box that is not its shape. Defaults to `contain`. */
  fit?: ImageFit;
  /**
   * How many rows to draw it in. With no `width`, the width follows from the
   * picture's proportions.
   */
  height?: number;
  /**
   * How many columns to draw it in. With no `height`, the height follows from
   * the picture's proportions. Defaults to the picture's own width in pixels,
   * or to the room it was offered where that is less.
   */
  width?: number;
}

/** A picture fitted into a box: the resampled pixels, and where they sit in it. */
interface Fitted {
  readonly image: RgbaImage;
  /** Where the picture's left edge is in the box, in pixels. */
  readonly x: number;
  /** Where its top edge is, in pixels, which is half a row. */
  readonly y: number;
}

/**
 * The rows a picture comes to at a width, at two pixels a row.
 *
 * At least one where there is anything to draw, so a picture very much wider
 * than it is tall is a line rather than nothing.
 *
 * @param image - The picture.
 * @param columns - The width it is drawn at.
 * @returns The rows.
 */
function rowsAt(image: RgbaImage, columns: number): number {
  if (columns <= 0 || image.width === 0 || image.height === 0) {
    return 0;
  }
  return Math.max(1, Math.round((image.height * columns) / image.width / 2));
}

/**
 * The columns a picture comes to at a height: `rowsAt()`'s ratio the other way
 * round, and rounded the other way round too, so not its exact inverse -- a
 * width taken to a height and back may land a column off where it started.
 *
 * @param image - The picture.
 * @param rows - The height it is drawn at.
 * @returns The columns.
 */
function columnsAt(image: RgbaImage, rows: number): number {
  if (rows <= 0 || image.width === 0 || image.height === 0) {
    return 0;
  }
  return Math.max(1, Math.round((image.width * rows * 2) / image.height));
}

/**
 * Fits a picture into a box of pixels.
 *
 * In pixels rather than in cells, and that is where the aspect ratio is
 * accounted for: a cell is one pixel across and two down, so a box of `columns`
 * by `rows` cells is `columns` by `rows * 2` pixels that are each about square,
 * and a picture fitted at its own proportions there is drawn at them.
 *
 * @param image - The picture.
 * @param width - The box's width in pixels.
 * @param height - The box's height in pixels.
 * @param fit - How to fill it.
 * @returns The picture at the size it is drawn, and its offset in the box.
 */
function fitInto(image: RgbaImage, width: number, height: number, fit: ImageFit): Fitted {
  if (fit === 'fill') {
    return { image: resampleImage(image, width, height), x: 0, y: 0 };
  }

  if (fit === 'cover') {
    // the largest rectangle of the picture with the box's proportions, centred:
    // whichever axis the box is relatively longer on keeps all of the picture
    const scale = Math.max(width / image.width, height / image.height);
    const across = width / scale;
    const down = height / scale;
    return {
      image: resampleImage(image, width, height, {
        height: down,
        width: across,
        x: (image.width - across) / 2,
        y: (image.height - down) / 2,
      }),
      x: 0,
      y: 0,
    };
  }

  const scale = Math.min(width / image.width, height / image.height);
  const across = Math.min(width, Math.max(1, Math.round(image.width * scale)));
  const down = Math.min(height, Math.max(1, Math.round(image.height * scale)));
  return {
    image: resampleImage(image, across, down),
    // centred, and a half-row offset is allowed: `Pixels` has a colour per half,
    // so the picture may start in the bottom half of a cell
    x: Math.floor((width - across) / 2),
    y: Math.floor((height - down) / 2),
  };
}

/**
 * One pixel over the background of the cell it lands in.
 *
 * Over a background the grid knows, a part-transparent pixel is mixed with it,
 * which is what alpha means. Over the terminal's own there is nothing to mix
 * with -- `DEFAULT_COLOR` is the absence of a colour rather than a colour, and
 * the terminal is not asked what its background is -- so a pixel is drawn or it
 * is not, at half: more than half covered is the pixel, less is the terminal
 * showing through. That is the rule the canvas keeps everywhere, that nothing
 * invents a colour, applied to the one input that arrives with an opinion
 * about transparency.
 *
 * A fully transparent pixel is `DEFAULT_COLOR` over either, rather than the
 * background's own colour, so that it paints nothing: `Pixels` skips a cell
 * whose halves are both default, and a half block's default half keeps the
 * background already in the cell -- the same answer in every case the two
 * would agree, and the right one where the cell holds something else.
 *
 * @param data - The resampled picture's bytes.
 * @param at - Where the pixel starts in them.
 * @param under - The background's channels, or `undefined` for the terminal's own.
 * @returns The colour to draw, or `DEFAULT_COLOR` for none.
 */
function over(
  data: Uint8Array,
  at: number,
  under: readonly [number, number, number] | undefined
): Color {
  const alpha = data[at + 3];
  if (alpha === 0) {
    return DEFAULT_COLOR;
  }
  if (alpha === 255) {
    return rgb(data[at], data[at + 1], data[at + 2]);
  }
  if (under === undefined) {
    return alpha >= 128 ? rgb(data[at], data[at + 1], data[at + 2]) : DEFAULT_COLOR;
  }
  const t = alpha / 255;
  return rgb(
    Math.round(data[at] * t + under[0] * (1 - t)),
    Math.round(data[at + 1] * t + under[1] * (1 - t)),
    Math.round(data[at + 2] * t + under[2] * (1 - t))
  );
}

/**
 * The picture, as an element that fits it to whatever box layout gives it.
 *
 * It **asks** for the picture's own size -- one column per pixel across, a row
 * per two pixels down -- or for the room it was offered where that is less, at
 * the picture's proportions; `width` and `height` ask for a size instead. What
 * it is **given** is what it draws at: a flex row that squeezes it, a column
 * that stretches it, a stylesheet's `width: 50%`, each resamples the picture to
 * the box it ended up with, and `fit` says what happens where the box is not the
 * picture's shape. Both minimums are zero, so it shrinks where a row is short of
 * room rather than pushing its siblings off the edge -- a picture is drawn at a
 * size, unlike a word, which has one.
 *
 * The resample is the expensive part and is done once per box size, not once per
 * frame: a frame repaints every cell, and redoing a box filter over a photograph
 * sixty times a second to get the same answer is the cost this keeps out of the
 * frame. What is done per frame is the composition over the background, because
 * the background is the grid's and may have changed, and the colour depth.
 *
 * **Colour depth comes free and is still worth saying.** A 256-colour terminal
 * gets the Oklab match per half-cell, through `quantizeColor()`, which is the
 * matcher every stylesheet colour goes through; a 16-colour one gets the nearest
 * of the basic sixteen; and at level 0 -- a pipe, `NO_COLOR` -- it draws nothing,
 * since a picture with its colour taken away is not a picture. The depth is the
 * one the tree was resolved at, read off the element, so it is the frame's own
 * and not a second guess at it. The box is still reserved at level 0: a layout
 * that moved because colour went away would be a layout that depends on it.
 *
 * @param input - The picture: PNG bytes, or RGBA. A caller with a JPEG or
 *   anything else brings their own decoder and passes its pixels in.
 * @param opts - The fit, and a size to ask for in place of the picture's own.
 * @returns The element, and the size it asks for given unlimited room.
 * @throws Whatever `decodePng()` throws for bytes that are not a PNG it can
 *   read, and a `TypeError` for RGBA whose data does not match its size --
 *   here, when the view is built, rather than from inside a frame.
 */
export function imageView(
  input: ImageSource,
  opts: ImageViewOptions = {}
): { element: Element; height: number; width: number } {
  const source = pictureOf(input);
  const fit = opts.fit ?? 'contain';
  const asked = cells(opts.width, 'width');
  const askedRows = cells(opts.height, 'height');

  // a height alone says how wide too, at the picture's proportions -- which a
  // width alone does for the height in `measure()`, where the width it is asked
  // at is the one layout settled on. A height is the one thing kept as asked
  // whatever the width comes to, since "fit this many rows" is what it says
  const width = asked ?? (askedRows === undefined ? source.width : columnsAt(source, askedRows));
  const height = askedRows ?? rowsAt(source, width);

  let fitted: { fitted: Fitted; height: number; width: number } | undefined;
  // a picture is a few thousand colours nobody declared, so the degrader's own
  // memo is the wrong place for them; this one lives as long as the element
  // and is dropped whenever the depth or the picture's size moves
  let quantized = new Map<Color, Color>();
  let quantizedAt: number | undefined;

  const element = raw(
    {
      // the width it is asked about is the one it will have: the `max-width` the
      // request became, the padding and border, and a row that flexed it narrower
      // have all been taken off by the time it arrives. So the request is a ceiling on that
      // rather than an answer that ignores it -- answering the request regardless
      // reserved the rows of a 40-column picture for one drawn at 10, and left
      // them as bands around a letterbox
      measure: (available) => {
        const columns = Math.min(width, Math.max(0, Math.floor(available)));
        return {
          height: askedRows ?? rowsAt(source, columns),
          minHeight: 0,
          minWidth: 0,
          width: columns,
        };
      },
      paint: (painter, box, self) => {
        const level = self.colorLevel;
        if (level === 0 || box.width <= 0 || box.height <= 0) {
          return;
        }
        if (source.width === 0 || source.height === 0) {
          return;
        }

        const across = box.width;
        const down = box.height * 2;
        if (fitted?.width !== across || fitted.height !== down) {
          fitted = { fitted: fitInto(source, across, down, fit), height: down, width: across };
          quantized = new Map();
        }
        // and bounded besides: one picture at one size is at most a colour per
        // pixel per background it has been composed over, and a background that
        // moves under a part-transparent picture is a new set every frame. Asked
        // before the frame adds its own -- at most one entry a pixel -- so the
        // limit is three a pixel here and four is the most the map ever holds
        if (quantizedAt !== level || quantized.size > across * down * 3) {
          quantized = new Map();
          quantizedAt = level;
        }

        const { image, x: left, y: top } = fitted.fitted;
        const pixels = new Pixels(box.width, box.height);

        for (let row = 0; row < box.height; row++) {
          for (let column = 0; column < box.width; column++) {
            const px = column - left;
            // a cell nobody can see is not composed or matched, which is most of
            // a picture scrolled half out of a pane; `Pixels.blit()` asks the
            // same question for the style table's sake
            if (px < 0 || px >= image.width || !painter.inside(box.x + column, box.y + row)) {
              continue;
            }

            // one read per cell, because both halves are one cell and share its
            // background
            const bg = painter.backgroundAt(box.x + column, box.y + row);
            const under = bg === DEFAULT_COLOR ? undefined : colorRgb(bg);

            for (let half = 0; half < 2; half++) {
              const py = row * 2 + half - top;
              if (py < 0 || py >= image.height) {
                continue;
              }
              let color = over(image.data, (py * image.width + px) * 4, under);
              if (color !== DEFAULT_COLOR && level < 3) {
                const known = quantized.get(color);
                if (known === undefined) {
                  const answer = quantizeColor(color, level);
                  quantized.set(color, answer);
                  color = answer;
                } else {
                  color = known;
                }
              }
              pixels.set(column, row * 2 + half, color);
            }
          }
        }

        pixels.blit(painter, box.x, box.y);
      },
    },
    {
      class: 'sigil-image',
      // a width asked for is a `max-width` and not a `width`, and that is the
      // whole of the difference between a picture that shrinks and one that does
      // not: a declared width is what the layout measures a node at however
      // narrow a row then flexed it, so a 40-column request squeezed to 17 kept
      // the height of 40. As a ceiling it is still the size asked for where
      // there is room -- `measure()` answers it -- and a column's stretch stops
      // at it rather than widening the picture to the column. A height alone
      // says how wide too, which `measure()` cannot say on its own: it is asked
      // about widths and answers heights.
      //
      // A prop, so it is this element's inline style: a stylesheet's
      // `max-width` on `.sigil-image` does not tighten a size the caller asked
      // for in code, exactly as a sheet's `color` does not reach a colour a
      // component wrote as a prop -- and `!important` is how a theme does, which
      // is the escape the cascade keeps for that. A sheet's `width` is a
      // different property and still applies, under the request as a ceiling
      ...(asked === undefined && askedRows === undefined ? {} : { 'max-width': width }),
      ...(askedRows === undefined ? {} : { height: askedRows }),
    }
  );

  return { element, height, width };
}

/**
 * The RGBA a source stands for, decoded where it is a PNG and checked where it
 * is not.
 *
 * @param input - The picture.
 * @returns Its pixels.
 */
function pictureOf(input: ImageSource): RgbaImage {
  if (input instanceof Uint8Array) {
    return decodePng(input);
  }
  assertRgbaImage(input, { name: 'imageView()' });
  return input;
}

/**
 * A size in cells, refused where it is not one.
 *
 * @param value - What was asked for.
 * @param name - Which, for the message.
 * @returns The size, or `undefined` for none.
 */
function cells(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `Invalid image ${name} ${String(value)}: expected a whole number of cells`
    );
  }
  return value;
}

export interface ImageOptions extends StyledOptions, ImageViewOptions {}

/**
 * Renders a picture as lines of half blocks.
 *
 * A facade over `imageView()`, the way `qrcode()` is over its view: the tree is
 * laid out and painted onto a grid of its own, and what comes back is the grid
 * read as lines. As wide as the picture, or as the terminal where that is less,
 * unless `width` or `height` say otherwise.
 *
 * At colour level 0 it is the empty string, which is what a picture with no
 * colour comes to: a pipe or `NO_COLOR` asked for no escape sequences, and a
 * column of blank lines the height of the picture would be a strange thing to
 * have written into a log instead. Inside a tree the box is reserved and left
 * blank; here there is no tree to keep the shape of.
 *
 * @param source - The picture: PNG bytes, or RGBA.
 * @param opts - The size, the fit, and the colour depth.
 * @returns The lines, with no trailing newline.
 * @throws What `imageView()` throws, at every level -- a bad picture does not
 *   hide behind a pipe.
 */
export function image(source: ImageSource, opts: ImageOptions = {}): string {
  const colorLevel = colorLevelOf(opts);
  const { element, width } = imageView(source, opts);
  if (colorLevel === 0) {
    return '';
  }

  // the terminal is the ceiling only where nobody named a size: a width is laid
  // out as asked, and a height is a width too, at the picture's proportions --
  // capping that at the terminal handed the layout a narrower room than the
  // picture's own `max-width`, so a 40-row picture came out letterboxed into
  // however many columns the terminal had
  const room = opts.width ?? (opts.height === undefined ? Math.min(width, terminalWidth()) : width);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel,
    colorScheme: opts.colorScheme,
    width: Math.max(1, room),
  });
}
