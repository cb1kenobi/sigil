/**
 * The file manager's root component, in JSX.
 *
 * `root.ui.ts` beside it is the same screen in the `ui` tag -- the same elements
 * in the same order, though not the same lines -- and the examples' smoke test
 * asserts that the two draw the same first screen. Everything that is not the
 * tree -- the states, the reads, the keys and the dialogs -- is `createModel()`'s,
 * written once in `model.ts`, and this hands the parts its keys reach back to it
 * through `attach()`.
 *
 * JSX is what an editor can check: every prop of `ListView`, `Panel` and
 * `TextField` is typed, and `row` is checked against the items it is handed. What
 * it costs is a build: Node strips types and does not compile JSX, so this file
 * only ever runs as `sigil build` wrote it.
 */

import { entryClass, entryLabel } from './common.ts';
import type { Entry } from './files.ts';
import { createModel } from './model.ts';
import { PreviewPane } from './preview-pane.ts';
import { keyHelp, ListView, Panel, TextField } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';

export { stylesheet } from './common.ts';

/**
 * Three columns -- the directory above, the one the manager is in, and a preview
 * of the selection -- under the path and over the keys.
 *
 * @returns The screen.
 */
export function App(): Element {
  const m = createModel();

  const parent = (
    <ListView
      current={m.parent.cursor}
      empty=""
      items={m.parent.items}
      key={(entry: Entry) => entry.name}
      props={{ class: 'list', tabindex: -1 }}
      row={(entry) => <text class={`name ${entryClass(entry)}`}>{entryLabel(entry)}</text>}
      scrollbar={false}
    />
  );
  const current = (
    <ListView
      current={m.current.cursor}
      empty={() => <text class="sigil-muted">{m.current.empty}</text>}
      items={m.current.items}
      key={(entry: Entry) => entry.name}
      onActivate={m.current.open}
      props={{ class: 'list' }}
      row={(entry) => (
        <box class="row">
          <text class={`name ${entryClass(entry)}`}>{entryLabel(entry)}</text>
          <text class="size sigil-muted">{m.sizeOf(entry)}</text>
        </box>
      )}
      vim
    />
  );
  const preview = <PreviewPane preview={m.preview} />;
  const filterField = (
    <TextField
      onChange={m.filter.change}
      onSubmit={m.filter.submit}
      placeholder="part of a name"
      props={{ 'flex-grow': 1 }}
      value={m.filter.draft}
    />
  );
  const filterBar = (
    <box class="filter-bar">
      <text class="filter-label sigil-accent">/</text>
      {filterField}
    </box>
  );

  const panels = {
    current: (
      <Panel class="current" title={m.titles.current}>
        {current}
      </Panel>
    ),
    parent: (
      <Panel class="parent" title={m.titles.parent}>
        {parent}
      </Panel>
    ),
    preview: (
      <Panel class="preview" title={m.titles.preview}>
        {preview}
      </Panel>
    ),
  };
  m.attach({ current, filterBar, filterField, panels, preview });

  return (
    <box class="app">
      <box class="header">
        <text class="path sigil-accent">{m.path}</text>
        <box class="spacer" />
        <text class="flags sigil-muted">{m.flags}</text>
      </box>
      <box class="columns">
        {panels.parent}
        {panels.current}
        {panels.preview}
      </box>
      {filterBar}
      <box class="footer">
        <text class="status sigil-accent">{m.status}</text>
        {keyHelp(m.input)}
      </box>
    </box>
  );
}
