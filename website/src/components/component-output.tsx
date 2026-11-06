'use client';

import { capture } from '@/lib/analytics';
import { componentViewStore } from '@/lib/component-view-store';
import type { ViewId } from '@/lib/components';
import { nextTabIndex } from '@/lib/install-command';
import { useId, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';

export interface OutputView {
  readonly id: ViewId;
  /** The tab's label. */
  readonly label: string;
  /** The right of the title bar: the shell and the size. */
  readonly size: string;
  /** What the caption under the unit says of this view. */
  readonly caption: string;
  /** The screen, drawn on the server. */
  readonly panel: ReactNode;
}

/**
 * The terminal half of a component's example: one captured screen per view,
 * with the views as tabs in the title bar.
 *
 * Proper tabs: a `tablist` of `tab`s, each controlling its `tabpanel`, one tab
 * in the tab order (the selected one), and the arrow keys, Home and End moving
 * between them and selecting as they go -- `nextTabIndex()` is the install
 * box's, so the two tab rows on the site answer the same keys. The panels are
 * rendered on the server and only shown or hidden here, so every view is in the
 * HTML and a reader without JavaScript gets the first.
 *
 * The choice is `componentViewStore`'s, kept for the session, so a reader who
 * wants the accessible form keeps getting it from page to page; a page without
 * the view it remembers shows Rendered. Choosing one sends
 * `component_output_viewed`.
 */
export function ComponentOutput({
  component,
  views,
}: {
  /** The component's slug, for the analytics event. */
  component: string;
  views: readonly OutputView[];
}) {
  const stored = useSyncExternalStore(
    componentViewStore.subscribe,
    componentViewStore.getSnapshot,
    componentViewStore.getServerSnapshot
  );
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = views.find((view) => view.id === stored) ?? views[0]!;

  function choose(view: OutputView) {
    if (view.id === current.id) {
      return;
    }
    componentViewStore.select(view.id);
    capture('component_output_viewed', { component, view: view.id });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const target = nextTabIndex(index, event.key, views.length);
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    choose(views[target]!);
    tabs.current[target]?.focus();
  }

  return (
    <>
      <div className="overflow-hidden rounded-b-panel border border-t-0 border-line-panel bg-terminal">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-term py-1.5 pr-4 pl-2">
          <div role="tablist" aria-label="Output" className="flex gap-1">
            {views.map((view, index) => {
              const selected = view.id === current.id;
              return (
                <button
                  key={view.id}
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${view.id}`}
                  aria-selected={selected}
                  aria-controls={`${id}-panel-${view.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => choose(view)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  className={`relative h-9 cursor-pointer rounded-segment border px-3.5 font-mono text-xs after:absolute after:inset-x-0 after:-inset-y-[5px] ${
                    selected
                      ? 'border-line-strong bg-surface-2 text-fg-strong'
                      : 'border-transparent text-muted hover:text-fg-body'
                  }`}
                >
                  {view.label}
                </button>
              );
            })}
          </div>
          <span className="ml-auto font-mono text-xs text-dim">{current.size}</span>
        </div>
        {views.map((view) => (
          <div
            key={view.id}
            role="tabpanel"
            id={`${id}-panel-${view.id}`}
            aria-labelledby={`${id}-tab-${view.id}`}
            hidden={view.id !== current.id}
            // scrolls sideways, so it has to be reachable by keyboard
            tabIndex={0}
            className="overflow-x-auto px-5 pt-4 pb-5 font-mono text-term text-fg-term focus-visible:-outline-offset-2"
          >
            {view.panel}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[14px] leading-[1.55] text-muted">{current.caption}</p>
    </>
  );
}
