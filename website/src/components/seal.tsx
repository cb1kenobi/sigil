import { SEAL_CELLS, SEAL_PATH } from '@/lib/seal';

type SealProps = {
  /**
   * The seal's side in pixels. A multiple of 7 (14, 28, 56) puts every cell
   * edge on a pixel; the header's 22 and the footer's 20 are not, and
   * `crispEdges` is what keeps them sharp anyway.
   * @default 28
   */
  size?: number;
  /**
   * Replaces the default, `text-brand`, so a caller that passes one passes the
   * colour too (`text-fg`, say): the seal is `currentColor`.
   */
  className?: string;
  /**
   * What a screen reader says. Omit it where the seal sits beside the word
   * `sigil` or is otherwise decoration, which is the usual case, and it is
   * hidden from assistive technology; pass it where the seal stands alone.
   */
  title?: string;
};

/**
 * The seal: a signet stamp cut from a 7 by 7 block of cells with one channel
 * carved through it (SIG-102). Inline, so it takes its colour from
 * `currentColor` and needs no request.
 *
 * The geometry is `SEAL_PATH`, which the favicon, the app icons and the social
 * cards read too.
 */
export function Seal({ size = 28, className = 'text-brand', title }: SealProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${SEAL_CELLS} ${SEAL_CELLS}`}
      shapeRendering="crispEdges"
      className={className}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <path fill="currentColor" fillRule="evenodd" d={SEAL_PATH} />
    </svg>
  );
}
