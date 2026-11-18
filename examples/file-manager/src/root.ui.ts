/**
 * The file manager's root component, in the `ui` tag.
 *
 * The same screen as `root.tsx` -- the same elements in the same order, though
 * not the same lines -- and the examples' smoke test asserts that the two draw
 * the same first screen. Everything that is not the tree is `createModel()`'s, in
 * `model.ts`, which neither root is.
 *
 * This one runs as it is: `node src/ui.ts` and nothing in between. A component is
 * interpolated rather than named (`<${ListView} />`), because a tag has no scope
 * to look a name up in; host elements stay bare. What it gives up is the checking
 * -- a misspelt prop is a runtime refusal rather than an editor's red line, and
 * `row` is handed items the types know nothing about, so its parameter is
 * annotated by hand.
 */

import { entryClass, entryLabel } from './common.ts';
import type { Entry } from './files.ts';
import { createModel } from './model.ts';
import { PreviewPane } from './preview-pane.ts';
import { keyHelp, ListView, Panel, TextField } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';

export { stylesheet } from './common.ts';

/**
 * Three columns -- the directory above, the one the manager is in, and a preview
 * of the selection -- under the path and over the keys.
 *
 * @returns The screen.
 */
export function App(): Element {
  const m = createModel();

  const parentRow = (entry: Entry): Element =>
    ui`<text class=${`name ${entryClass(entry)}`}>${entryLabel(entry)}</text>`;
  const parent = ui`
    <${ListView}
      current=${m.parent.cursor}
      empty=""
      items=${m.parent.items}
      key=${(entry: Entry) => entry.name}
      props=${{ class: 'list', tabindex: -1 }}
      row=${parentRow}
      scrollbar=${false}
    />
  `;

  const currentRow = (entry: Entry): Element => ui`
    <box class="row">
      <text class=${`name ${entryClass(entry)}`}>${entryLabel(entry)}</text>
      <text class="size sigil-muted">${m.sizeOf(entry)}</text>
    </box>
  `;
  const current = ui`
    <${ListView}
      current=${m.current.cursor}
      empty=${() => ui`<text class="sigil-muted">${m.current.empty}</text>`}
      items=${m.current.items}
      key=${(entry: Entry) => entry.name}
      onActivate=${m.current.open}
      props=${{ class: 'list' }}
      row=${currentRow}
      vim
    />
  `;
  const preview = ui`<${PreviewPane} preview=${m.preview} />`;
  const filterField = ui`
    <${TextField}
      onChange=${m.filter.change}
      onSubmit=${m.filter.submit}
      placeholder="part of a name"
      props=${{ 'flex-grow': 1 }}
      value=${m.filter.draft}
    />
  `;
  const filterBar = ui`
    <box class="filter-bar">
      <text class="filter-label sigil-accent">/</text>
      ${filterField}
    </box>
  `;

  const panels = {
    current: ui`<${Panel} class="current" title=${m.titles.current}>${current}</>`,
    parent: ui`<${Panel} class="parent" title=${m.titles.parent}>${parent}</>`,
    preview: ui`<${Panel} class="preview" title=${m.titles.preview}>${preview}</>`,
  };
  m.attach({ current, filterBar, filterField, panels, preview });

  return ui`
    <box class="app">
      <box class="header">
        <text class="path sigil-accent">${m.path}</text>
        <box class="spacer" />
        <text class="flags sigil-muted">${m.flags}</text>
      </box>
      <box class="columns">
        ${panels.parent}
        ${panels.current}
        ${panels.preview}
      </box>
      ${filterBar}
      <box class="footer">
        <text class="status sigil-accent">${m.status}</text>
        ${keyHelp(m.input)}
      </box>
    </box>
  `;
}
