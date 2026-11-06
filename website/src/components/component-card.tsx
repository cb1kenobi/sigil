import { TerminalRows } from '@/components/terminal-block';
import { describeComponent, hasLineForm, previewRows } from '@/lib/component-data';
import { componentEntry, componentHref } from '@/lib/components';
import type { Row } from '@/lib/terminal-rows';
import Link from 'next/link';

/**
 * A screen without a title bar, cut off at the height it is given: the preview
 * on a component card.
 *
 * `aria-hidden`, because the card is a link that already says what it is, and a
 * reader of the screen gets nothing from four lines of a table read out one
 * cell at a time. It is real output, not decoration, so it stays in the page for
 * everyone who can see it.
 */
export function ScreenPreview({ rows, size }: { rows: readonly Row[]; size: 'home' | 'index' }) {
  return (
    <div
      aria-hidden="true"
      className={`overflow-hidden border-b border-line-term bg-terminal font-mono text-fg-term ${
        size === 'home'
          ? 'h-[124px] px-5 py-4 text-term-card'
          : 'h-[100px] px-4 py-3.5 text-[12.5px] leading-[1.55]'
      }`}
    >
      <TerminalRows rows={rows} />
    </div>
  );
}

/** The Accessible badge: the component has a line form a screen reader can follow. */
export function AccessibleBadge() {
  return (
    <span className="rounded-kbd bg-badge-a11y px-[7px] py-0.5 font-mono text-[11px] text-badge-a11y-fg">
      Accessible
    </span>
  );
}

/**
 * A card linking to a component's page: a few lines of what it really draws,
 * its name, and what it is for.
 *
 * The home page's Components section and the components index draw the same
 * card from the same metadata and the same capture, at two sizes. The whole card
 * is the link, so its name is the link's name and the preview is hidden from a
 * screen reader.
 *
 * @param props.slug - Which component.
 * @param props.size - `home` is the larger card of the home page; `index` is the
 *   index's, which also carries the Accessible badge.
 */
export function ComponentCard({ size, slug }: { size: 'home' | 'index'; slug: string }) {
  const entry = componentEntry(slug);
  if (!entry) {
    throw new Error(`no component called "${slug}" in src/lib/components.ts`);
  }

  return (
    <Link
      className="flex w-full min-w-0 flex-col overflow-hidden rounded-panel border border-line-panel bg-surface hover:border-line-strong"
      href={componentHref(slug)}
    >
      <ScreenPreview rows={previewRows(slug)} size={size} />
      <span
        className={`flex flex-col gap-1.5 ${size === 'home' ? 'px-5 pt-4 pb-5' : 'px-4 pt-3.5 pb-4'}`}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-bold text-fg-strong">{entry.name}</span>
          {size === 'index' && hasLineForm(slug) ? <AccessibleBadge /> : null}
        </span>
        <span
          className={
            size === 'home' ? 'text-small text-muted' : 'text-[13.5px] leading-[1.5] text-muted'
          }
        >
          {describeComponent(entry)}
        </span>
      </span>
    </Link>
  );
}
