/**
 * Stand-ins for components sigil does not have yet.
 *
 * Each one is the least that makes the monitor work, kept here rather than in
 * the package so that it can be deleted the day the real component lands. They
 * are written imperatively, with `box()` and `text()`, because they put handlers
 * on nodes inside themselves -- the table body's `onResize` and `onMouse` -- and a
 * template has no way to reach one: handlers are not template props, and there is
 * no `ref`. The README has the details, under "What is a stand-in".
 */

import { SORTS, scrollTop } from './data.js';
import { box, text } from '@ttylabs/sigil/element';
import { createEffect } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

/**
 * A bordered box with a title sitting in its top border.
 *
 * stand-in for SIG-277: the title is a `position: absolute` child at `top: -1`,
 * which lands on the border row because the containing block is the padding box.
 * It covers the border characters it sits on rather than being drawn into them,
 * so the title's own padding is what keeps a gap either side.
 *
 * @param {{ title: string | (() => string), class?: string }} props - The title, and
 *   any extra classes for the box.
 * @param {...import('@ttylabs/sigil/element').Element} children - What goes inside.
 * @returns {import('@ttylabs/sigil/element').Element} The panel.
 */
export function Panel(props, ...children) {
  const title = text('', { class: 'panel-title' });
  if (typeof props.title === 'function') {
    const read = props.title;
    createEffect(() => title.setText(` ${read()} `));
  } else {
    title.setText(` ${props.title} `);
  }
  // the clip is on an inner box rather than on the panel: `overflow: hidden`
  // clips to the padding box, which is exactly the row the title is not in, so a
  // panel that clipped its own content would clip its own title away
  return box(
    { class: ['panel', props.class ?? ''].join(' ').trim() },
    title,
    box({ class: 'panel-body' }, ...children)
  );
}

/**
 * A chart that redraws when its data changes and when the layout resizes it.
 *
 * stand-in for SIG-284: the charts in `@ttylabs/sigil/components` take an array
 * and a width when they are built and never change, so this throws the old one
 * away and builds a new one -- every tick, for every chart on screen. The size
 * comes from `onResize`, the way `TextField` learns its width.
 *
 * @param {{ data: () => readonly number[],
 *   draw: (data: readonly number[], size: { height: number, width: number }) =>
 *     import('@ttylabs/sigil/element').Element,
 *   class?: string }} props - Where the data comes from and how to draw it at a size.
 * @returns {import('@ttylabs/sigil/element').Element} The chart's host.
 */
export function LiveChart(props) {
  const host = box({ class: ['live-chart', props.class ?? ''].join(' ').trim() });
  let size = { height: 0, width: 0 };
  let data = props.data();

  const redraw = () => {
    // there is no replacing an element's children, so the old chart is taken
    // out first and the new one put in its place
    const old = host.children[0];
    if (old) {
      host.removeChild(old);
    }
    if (size.width > 0 && size.height > 0) {
      host.append(props.draw(data, size));
    }
  };

  host.onResize = (el) => {
    const width = el.box?.width ?? 0;
    const height = el.box?.height ?? 0;
    if (width === size.width && height === size.height) {
      return false;
    }
    size = { height, width };
    redraw();
    return true;
  };

  createEffect(() => {
    data = props.data();
    redraw();
  });

  return host;
}

/** The columns, as fixed widths, with the name taking whatever is left. */
const COLUMNS = Object.freeze([
  { align: 'right', key: 'pid', label: 'PID', width: 7 },
  { align: 'left', key: 'user', label: 'USER', width: 10 },
  { align: 'right', key: 'cpu', label: 'CPU%', width: 6 },
  { align: 'right', key: 'mem', label: 'MEM%', width: 6 },
  { align: 'right', key: 'rss', label: 'RSS', width: 9 },
  { align: 'left', key: 'name', label: 'NAME', width: 0 },
]);

/**
 * A table of processes: a header, as many rows as fit, a selection that follows
 * a pid, and a scroll position that keeps the selection on screen.
 *
 * stand-in for SIG-281: the columns are padded strings rather than a layout,
 * because `tableView()` builds a static block and `selectRow()` is a prompt.
 * Rows are a pool of text elements the size of the visible area, rewritten in
 * place each tick; the pool is rebuilt when the layout changes its height.
 *
 * @param {{ rows: () => readonly import('./data.js').Process[],
 *   selected: State<number | undefined>,
 *   sort: () => keyof typeof SORTS,
 *   format: (p: import('./data.js').Process, key: string) => string }} props
 * @returns {{ element: import('@ttylabs/sigil/element').Element,
 *   move(by: number): void, page(by: number): void, home(): void, end(): void }}
 *   The table, and the moves its keys make.
 */
export function ProcessTable(props) {
  const header = text('', { class: 'table-header' });
  const body = box({ class: 'table-body' });
  const element = box({ class: 'table', focusable: true }, header, body);

  /** The first visible row. Kept across ticks, so the view does not jump. */
  let top = 0;
  let width = 0;
  /** @type {import('@ttylabs/sigil/element').Element[]} */
  let pool = [];
  const height = new State(0);

  const line = (cells) => {
    const fixed = COLUMNS.reduce((acc, c) => acc + c.width + 1, 0);
    const nameWidth = Math.max(4, width - fixed);
    return COLUMNS.map((c, i) => {
      const w = c.width || nameWidth;
      const cell = cells[i].length > w ? cells[i].slice(0, w) : cells[i];
      return c.align === 'right' ? cell.padStart(w) : cell.padEnd(w);
    }).join(' ');
  };

  const draw = () => {
    const sort = props.sort();
    header.setText(
      line(
        COLUMNS.map((c) => (c.key === sort ? `${c.label}${SORTS[sort].desc ? '▼' : '▲'}` : c.label))
      )
    );
    const rows = props.rows();
    const pid = props.selected.get();
    const at = Math.max(
      0,
      rows.findIndex((p) => p.pid === pid)
    );
    top = scrollTop(top, at, pool.length, rows.length);
    pool.forEach((row, i) => {
      const p = rows[top + i];
      row.setText(p ? line(COLUMNS.map((c) => props.format(p, c.key))) : '');
      row.toggleClass('selected', p !== undefined && p.pid === pid);
    });
  };

  body.onResize = (el) => {
    const h = el.box?.height ?? 0;
    const w = el.box?.width ?? 0;
    if (h === pool.length && w === width) {
      return false;
    }
    width = w;
    if (h !== pool.length) {
      for (const row of pool) {
        body.removeChild(row);
      }
      pool = Array.from({ length: h }, () => text('', { class: 'table-row' }));
      body.append(...pool);
      height.set(h);
    }
    draw();
    return true;
  };

  createEffect(() => {
    height.get();
    draw();
  });

  const go = (to) => {
    const rows = props.rows();
    if (rows.length === 0) {
      return;
    }
    const at = rows.findIndex((p) => p.pid === props.selected.get());
    const next = Math.min(rows.length - 1, Math.max(0, to(at < 0 ? 0 : at, rows.length)));
    props.selected.set(rows[next].pid);
  };

  // a click picks the row under it, which is the one place the pool's position
  // has to be turned back into a process
  body.onMouse = (event) => {
    if (event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    const index = pool.indexOf(event.target);
    const p = props.rows()[top + index];
    if (index >= 0 && p) {
      props.selected.set(p.pid);
      event.stop();
    }
  };

  return {
    element,
    end: () => go((_, n) => n - 1),
    home: () => go(() => 0),
    move: (by) => go((at) => at + by),
    page: (by) => go((at) => at + by * Math.max(1, pool.length - 1)),
  };
}
