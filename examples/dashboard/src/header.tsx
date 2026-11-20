/**
 * The header: the page's name, a search field, and the account menu.
 *
 * The search filters the table as it is typed into -- every word, anywhere in a
 * project's name, owner, region or status -- and `/` reaches it from anywhere a
 * field is not already taking keys. Enter hands the focus to the table with the
 * matches in it; Escape clears the field, or leaves it when it is already empty.
 *
 * The menu is a button that opens a menu under itself: the theme, the sidebar,
 * the search and quitting, each with the key that does the same beside it.
 */

import { type Dashboard, SECTIONS, TODAY } from './model.ts';
import { USER } from './sidebar.tsx';
import { THEMES } from './themes.ts';
import { useApp } from '@ttylabs/sigil/app';
import { Button } from '@ttylabs/sigil/components/button';
import { type MenuEntry, openMenu } from '@ttylabs/sigil/components/menu';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { TextField } from '@ttylabs/sigil/components/text-field';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';

/** What the header's controls do, which the root owns because its keys do the same. */
export interface HeaderActions {
  /** Puts the focus in the table. */
  focusTable(): void;
  /** Switches to one of the themes, by position. */
  setTheme(index: number): void;
  /** Collapses the sidebar, or brings it back. */
  toggleSidebar(): void;
}

/** What the header hands back: the row, and the two things in it that take the focus. */
export interface HeaderView {
  readonly element: Element;
  readonly menu: Element;
  readonly search: Element;
}

/**
 * Builds the header.
 *
 * @param d - The dashboard.
 * @param input - The router.
 * @param actions - What the menu's entries do.
 * @returns The row, the search field and the menu's button.
 */
export function buildHeader(d: Dashboard, input: InputRouter, actions: HeaderActions): HeaderView {
  const app = useApp();
  const ascii = !unicodeSupported();

  const search = TextField({
    onSubmit: () => actions.focusTable(),
    placeholder: 'Search projects',
    props: { class: 'search-field' },
    value: d.query,
  });
  // Escape is not the field's, so it reaches this box on its way up
  const onSearchKey = (event: KeyEvent): void => {
    const k = event.key;
    if (k.name !== 'escape' || event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }
    event.stop();
    if (d.query.get() === '') {
      actions.focusTable();
    } else {
      d.query.set('');
    }
  };

  const entries = (): MenuEntry<() => void>[] => {
    const on = d.theme.get();
    return [
      {
        // opens on the theme in use, so Enter keeps it and a letter or an arrow
        // starts from it
        initial: on,
        items: THEMES.map((theme, i) => ({
          hint: i === on ? (ascii ? '*' : '●') : '',
          label: `&${theme.label}`,
          value: () => actions.setTheme(i),
        })),
        label: '&Theme',
      },
      {
        hint: 'ctrl+b',
        label: d.collapsed.get() ? '&Expand sidebar' : '&Collapse sidebar',
        value: () => actions.toggleSidebar(),
      },
      { hint: '/', label: '&Search projects', value: () => input.focus.focus(search) },
      { separator: '' },
      { hint: 'q', label: '&Quit', value: () => app.exit(0) },
    ];
  };

  let button: Element | undefined;
  const open = (): void => {
    if (button === undefined) {
      return;
    }
    openMenu<() => void>(app.view, {
      at: button,
      input,
      items: entries(),
      onSelect: (item) => item.value?.(),
      side: 'bottom',
    });
  };
  button = Button({ label: `${USER} ${ascii ? 'v' : '▾'}`, onPress: open });

  const title = (): string =>
    SECTIONS.find((section) => section.id === (d.section.get() ?? 'overview'))?.label ?? '';

  const element = (
    <box class="header">
      <text class="title sigil-heading">{title}</text>
      <text class="crumb sigil-muted">{`· production · ${TODAY}`}</text>
      <box class="search" onKey={onSearchKey}>
        {search}
      </box>
      {button}
    </box>
  );

  return { element, menu: button, search };
}
