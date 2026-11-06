import type { ReactNode } from 'react';

export interface CalloutProps {
  readonly children: ReactNode;
  /**
   * What sits on the left: the seal, at 18px in `brand`, which the markdown
   * hook passes as `CALLOUT_ICON` in `markdown-blocks.tsx`. Left out, the
   * callout is its text alone.
   */
  readonly icon?: ReactNode;
}

/**
 * A note in the docs: a `surface` panel with the seal on the left, a bold
 * lead-in in `fg-strong`, then the body.
 *
 * The lead-in is the author's, written as the `**bold**` that opens the note, so
 * the callout itself carries no label: a "Note" heading over every one says
 * nothing a reader needs, and the lead-in says what this one is about.
 * `role="note"` is what tells assistive technology it is an aside.
 */
export function Callout({ children, icon }: CalloutProps) {
  return (
    <div
      className="callout mt-5 flex gap-3.5 rounded-panel border border-line-input bg-surface px-[18px] py-4 text-[15px] leading-[1.65] text-fg-body"
      role="note"
    >
      {icon ? (
        <span aria-hidden="true" className="mt-[3px] flex size-[18px] shrink-0">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
