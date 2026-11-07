import type { CSSProperties } from 'react';

/** How far down a docs page the glow reaches. */
const DOCS_FADE_HEIGHT = 520;

type GlowProps = {
  /**
   * `radial` sits behind the focal element of a hero. `top` is a docs page's,
   * centred on its top edge and 520px tall.
   */
  variant: 'radial' | 'top';
  /**
   * The brand colour's alpha: 0.30 behind a hero's focal element, 0.24 at the
   * top of a docs page.
   * @default 0.30 for `radial`, 0.24 for `top`
   */
  alpha?: number;
  /** The ellipse's radii as `x y`. `radial` has no default; `top` is `40% 70%`. */
  size?: string;
  /** The ellipse's centre as `x y`. `top` is `50% 0%`. */
  at?: string;
  /** Position and extent, for a band that does not start at the top of its parent. */
  className?: string;
};

/**
 * The brand glow layer: a radial gradient of the brand colour that fades to
 * nothing at 72% of the way out. The colour is `--color-brand` with an alpha
 * rather than a second copy of its channels.
 *
 * Decoration, so `aria-hidden` and `pointer-events-none`. It never sits between
 * a reader and the text it is behind. Its parent has to be `relative`, and
 * whatever should sit above it `relative` too.
 */
export function Glow({
  variant,
  alpha = variant === 'radial' ? 0.3 : 0.24,
  size = variant === 'top' ? '40% 70%' : '40% 55%',
  at = variant === 'top' ? '50% 0%' : '50% 50%',
  className,
}: GlowProps) {
  const style: CSSProperties = {
    background: `radial-gradient(ellipse ${size} at ${at}, color-mix(in srgb, var(--color-brand) ${+(alpha * 100).toFixed(2)}%, transparent), transparent 72%)`,
    ...(variant === 'top' ? { height: DOCS_FADE_HEIGHT } : null),
  };

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute ${variant === 'top' ? 'inset-x-0 top-0' : 'inset-0'} ${className ?? ''}`}
      style={style}
    />
  );
}
