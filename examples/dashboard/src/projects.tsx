/**
 * The projects table: sorting by a heading or a digit, ticking rows, a page at a
 * time, and a menu on each row.
 *
 * `DataTable` draws one page, which `src/model.ts` has already sorted and cut:
 * the table writes the sort when a heading is clicked and the model reads it, so
 * the order spans every page. Under it is the bar shadcn's table has -- how many
 * are ticked, how many rows a page holds, which page this is, and the buttons
 * that turn it.
 *
 * Enter, or a double click, opens the row's menu under the row. With rows ticked
 * the menu also offers to act on all of them, wherever they are: the selection
 * is ids, and outlives a page turn.
 */

import type { Project, Status } from './data.ts';
import { compact, percent } from './metrics.ts';
import { type Dashboard, PAGE_SIZES, SORT_VALUES } from './model.ts';
import { useApp } from '@ttylabs/sigil/app';
import { Button } from '@ttylabs/sigil/components/button';
import {
  DataTable,
  type DataTableColumn,
  dataTableControl,
  describeDataTable,
} from '@ttylabs/sigil/components/data-table';
import { Dropdown } from '@ttylabs/sigil/components/dropdown';
import { type MenuEntry, openMenu } from '@ttylabs/sigil/components/menu';
import { confirmModal } from '@ttylabs/sigil/components/modal';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { paginatorView } from '@ttylabs/sigil/components/paginator';
import { Panel } from '@ttylabs/sigil/components/panel';
import { showToast } from '@ttylabs/sigil/components/toast';
import { type Element, text } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { createEffect, onCleanup } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { stringWidth } from '@ttylabs/sigil/width';

/** What a status says, the mark before it in each glyph set, and the role it is drawn in. */
const STATUS: Readonly<
  Record<Status, { ascii: string; label: string; mark: string; role: string }>
> = {
  degraded: { ascii: '!', label: 'Degraded', mark: '●', role: 'sigil-warn' },
  healthy: { ascii: '*', label: 'Healthy', mark: '●', role: 'sigil-success' },
  paused: { ascii: '-', label: 'Paused', mark: '○', role: 'sigil-muted' },
};

/**
 * A status cell: a mark and the word, in the status's role.
 *
 * A view rather than a string, because a string cell is drawn in the row's own
 * colour; `table()`'s cells take a `{ element, width }` for exactly this, and it
 * is what `badgeView()` returns. A badge was the first version, and ten solid
 * blocks of green down one column outshouted everything else on the screen.
 *
 * @param status - The status.
 * @param ascii - Whether to mark it with ASCII.
 * @returns The cell.
 */
export function statusCell(status: Status, ascii: boolean): { element: Element; width: number } {
  const { label, role } = STATUS[status];
  const content = `${ascii ? STATUS[status].ascii : STATUS[status].mark} ${label}`;
  return {
    element: text(content, { class: `status ${role}`, 'flex-shrink': 0, 'white-space': 'nowrap' }),
    width: stringWidth(content),
  };
}

/**
 * The row under the table's cursor, as an element: where its menu opens.
 *
 * `DataTable` has no way to hand out the element a row was built as, so this
 * finds it by the classes `ListView` puts on it -- `sigil-list-row` and
 * `is-current` -- which are documented as hooks for a stylesheet. A gap, listed in
 * the README.
 *
 * @param host - The table.
 * @returns The current row, or `undefined` where there are no rows.
 */
export function currentRow(host: Element): Element | undefined {
  const walk = (at: Element): Element | undefined => {
    if (at.classes.includes('sigil-list-row') && at.classes.includes('is-current')) {
      return at;
    }
    for (const child of at.children) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(host);
}

/** What the table section hands back: the panel, and what the keys reach. */
export interface ProjectsView {
  readonly element: Element;
  /** The list inside the table, which is what takes the focus. */
  readonly list: Element;
  readonly table: Element;
}

/**
 * Builds the table section.
 *
 * @param d - The dashboard.
 * @param input - The router.
 * @returns The panel, the table and the list.
 */
export function buildProjects(d: Dashboard, input: InputRouter): ProjectsView {
  const app = useApp();
  const ascii = !unicodeSupported();
  const star = ascii ? '*' : '★';

  const columns: DataTableColumn<Project>[] = [
    {
      format: (name, p) => (p.starred ? `${star} ${String(name)}` : String(name)),
      grow: 1,
      header: 'Project',
      key: 'name',
      minWidth: 12,
      priority: 3,
    },
    {
      // a badge is a view, so its width is declared rather than measured
      descendingFirst: true,
      format: (_, p) => statusCell(p.status, ascii),
      header: 'Status',
      key: 'status',
      priority: 2,
      value: SORT_VALUES.status,
      width: 10,
    },
    { header: 'Region', key: 'region', priority: -1 },
    {
      align: 'right',
      descendingFirst: true,
      format: (n) => compact(Number(n)),
      header: 'Requests',
      key: 'requests',
      priority: 1,
    },
    {
      align: 'right',
      descendingFirst: true,
      format: (n) => percent(Number(n)),
      header: 'Errors',
      key: 'errorRate',
      priority: 0,
    },
    { header: 'Owner', key: 'owner', priority: -2 },
  ];

  let menu: () => void = () => {};
  const table = DataTable<Project, string>({
    columns,
    current: d.current,
    empty: 'No project matches the search',
    key: (p) => p.id,
    multiple: true,
    onActivate: () => menu(),
    props: { class: 'projects-table' },
    rows: d.page,
    // a page is short and the bar under it says where it is, so the scrollbar
    // would only ever be a full-height thumb
    scrollbar: false,
    selected: d.selected,
    sort: d.sort,
  });
  const control = dataTableControl<string>(table);
  if (control === undefined) {
    throw new Error('DataTable() returned an element it has no control for');
  }

  // -- what the menu does -----------------------------------------------------

  const say = (message: string, variant: 'error' | 'info' | 'success' = 'success'): void => {
    showToast(app.view, { message, variant });
  };
  const names = (list: readonly Project[]): string =>
    list.length === 1 ? (list[0]?.name ?? '') : `${list.length} projects`;
  const byIds = (ids: Iterable<string>): Project[] => {
    const set = new Set(ids);
    return d.projects.get().filter((p) => set.has(p.id));
  };

  // the figures are the last day's, which a project paused just now did serve,
  // so pausing leaves them alone -- and resuming reads its error rate back to
  // say whether it comes back degraded
  const pause = (list: readonly Project[], paused: boolean): void => {
    d.update(
      list.map((p) => p.id),
      (p) =>
        paused ? { status: 'paused' } : { status: p.errorRate > 0.015 ? 'degraded' : 'healthy' }
    );
    say(`${paused ? 'Paused' : 'Resumed'} ${names(list)}`, 'info');
  };
  const redeploy = (p: Project): void => {
    d.update([p.id], () => ({ errorRate: Math.min(p.errorRate, 0.004), status: 'healthy' }));
    say(`Redeployed ${p.name}`);
  };
  const remove = async (list: readonly Project[]): Promise<void> => {
    const yes = await confirmModal(app.view, {
      initial: 'no',
      input,
      message:
        list.length === 1
          ? `Delete ${names(list)}? Its deployments and logs go with it.`
          : `Delete ${names(list)}? Their deployments and logs go with them.`,
      title: list.length === 1 ? 'Delete project' : 'Delete projects',
      yes: 'Delete',
    });
    if (yes) {
      d.remove(list.map((p) => p.id));
      say(`Deleted ${names(list)}`, 'error');
    }
    input.focus.focus(control.list);
  };

  /** The menu for a row, and for the ticked rows when there are any. */
  const entries = (p: Project): MenuEntry<() => void>[] => {
    const paused = p.status === 'paused';
    const items: MenuEntry<() => void>[] = [
      { label: paused ? '&Resume' : '&Pause', value: () => pause([p], !paused) },
      {
        disabled: paused ? 'Resume it first' : false,
        label: 'R&edeploy',
        value: () => redeploy(p),
      },
      {
        label: p.starred ? 'Un&star' : '&Star',
        value: () => d.update([p.id], (q) => ({ starred: !q.starred })),
      },
      { separator: '' },
      { label: '&Delete...', value: () => void remove([p]) },
    ];

    // the ticked rows' actions are a submenu, so their letters are a level of
    // their own: two items sharing one at a level is a letter that steps between
    // them rather than choosing either, and `p` has to pause this row
    const ticked = byIds(d.selected.get());
    if (ticked.length > 0) {
      items.push(
        { separator: '' },
        {
          items: [
            { label: '&Pause', value: () => pause(ticked, true) },
            { label: '&Resume', value: () => pause(ticked, false) },
            { label: '&Clear selection', value: () => d.selected.set(new Set()) },
            { label: '&Delete...', value: () => void remove(ticked) },
          ],
          label: `&Ticked (${ticked.length})`,
        }
      );
    }
    return items;
  };

  menu = (): void => {
    const id = control.selection.current.get();
    const p = d.page.get().find((each) => each.id === id);
    if (p === undefined) {
      return;
    }
    // at the row's last cell, so the menu opens under the row's right end, as
    // the menu at the end of a web table's row does, and leaves its name in view.
    // A double click moves the cursor and activates in one handler, before the
    // effect that moves `is-current` has run, so a frame is settled first: it
    // runs that effect, and lays the row out where it is now
    app.view.frame();
    const row = currentRow(table)?.box;
    openMenu<() => void>(app.view, {
      // a cell is a point the menu's corner goes at, so the one under the row's
      // end: placed below it, and past the screen's edge, so it right-aligns
      at: row === undefined ? table : { x: row.x + row.width, y: row.y + row.height },
      input,
      items: entries(p),
      onSelect: (item) => item.value?.(),
    });
  };

  // -- the bar under the table ------------------------------------------------

  const perPage = new State<number | undefined>(d.pager.perPage);
  const rows = Dropdown<number>({
    input,
    onChange: (size) => {
      d.pager.perPage = size;
    },
    options: PAGE_SIZES.map((size) => ({ label: String(size), value: size })),
    value: perPage,
  });

  const onFirst = new State(true);
  const onLast = new State(true);
  createEffect(() => {
    onFirst.set(d.pager.onFirstPage);
    onLast.set(d.pager.onLastPage);
  });
  const previous = Button({
    disabled: onFirst,
    label: ascii ? '<' : '‹',
    onPress: () => d.pager.previous(),
  });
  const next = Button({
    disabled: onLast,
    label: ascii ? '>' : '›',
    onPress: () => d.pager.next(),
  });

  const ticked = (): string => {
    const n = d.selected.get().size;
    return `${n} of ${d.projects.get().length} selected`;
  };
  const annotation = (): string => {
    const shown = d.visible.get().length;
    const all = d.projects.get().length;
    return shown === all ? `${all} projects` : `${shown} of ${all} match`;
  };

  onCleanup(describeDataTable(input, table));

  const element = (
    <Panel class="projects" title="Projects" annotation={annotation}>
      {table}
      <box class="table-bar">
        <text class="ticked sigil-muted">{ticked}</text>
        <text class="bar-label sigil-muted">Rows</text>
        {rows}
        {paginatorView(d.pager.state, {
          format: (page, pages) => `Page ${page} of ${pages}`,
          style: 'numeric',
        })}
        {previous}
        {next}
      </box>
    </Panel>
  );

  return { element, list: control.list, table };
}
