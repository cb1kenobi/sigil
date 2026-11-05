import type { CSSProperties } from 'react';

/**
 * One dot per terminal cell: a 12px by 24px tile, which is what a cell is
 * drawn as on the canvas the site is designed from.
 */
const DOT = (alpha: number) =>
  `radial-gradient(circle, rgba(237, 235, 243, ${alpha}) 1px, transparent 1.5px)`;

/** How far down a docs page the grid and the glow reach. */
export const DOCS_FADE_HEIGHT = 520;

type CellGridProps = {
  /**
   * `radial` is the hero's: an ellipse that is solid in the middle and gone at
   * its edge. `fade` is a docs page's: solid at the top of the band and gone
   * at the bottom, over the top 520px.
   *
   * The grid is always masked. A bare one is a wall of dots, and the rule is
   * that it fades out.
   */
  variant: 'radial' | 'fade';
  /**
   * The dot's alpha. 0.12 in the heroes, 0.10 on bands and docs pages.
   * @default 0.12 for `radial`, 0.10 for `fade`
   */
  alpha?: number;
  /** `radial` only: the ellipse's radii as `x y`, as in `75% 90%`. */
  size?: string;
  /** `radial` only: the ellipse's centre as `x y`, as in `68% 45%`. */
  at?: string;
  /** `radial` only: where the mask is fully opaque and where it is gone, in percent. */
  stops?: [solid: number, gone: number];
  /** Position and extent, for a band that does not start at the top of its parent. */
  className?: string;
};

/**
 * The cell-grid background layer.
 *
 * It is decoration and is `aria-hidden`, which is not optional: a screen
 * reader has nothing to say about a pattern. It is also `pointer-events-none`,
 * so it never sits between a reader and the text it is behind. Its parent has
 * to be `relative`, and whatever should sit above it `relative` too.
 *
 * Pair it with `<Glow>`, which takes the same placement.
 */
export function CellGrid({
  variant,
  alpha = variant === 'radial' ? 0.12 : 0.1,
  size = '75% 90%',
  at = '50% 50%',
  stops = [20, 78],
  className,
}: CellGridProps) {
  const mask =
    variant === 'radial'
      ? `radial-gradient(ellipse ${size} at ${at}, #000 ${stops[0]}%, transparent ${stops[1]}%)`
      : 'linear-gradient(to bottom, #000, transparent)';

  const style: CSSProperties = {
    backgroundImage: DOT(alpha),
    backgroundSize: '12px 24px',
    maskImage: mask,
    WebkitMaskImage: mask,
    ...(variant === 'fade' ? { height: DOCS_FADE_HEIGHT } : null),
  };

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute ${variant === 'fade' ? 'inset-x-0 top-0' : 'inset-0'} ${className ?? ''}`}
      style={style}
    />
  );
}
