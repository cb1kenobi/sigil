/**
 * The editor's screen: the file tree down the left, the open files in tabs over
 * a text area, and a Markdown preview beside it for a `.md` file.
 *
 * Written in JSX, so `sigil build` compiles it and an editor checks every prop.
 * `App` is the whole screen, mounted by `runApp()`: `src/index.ts` runs it on the
 * real terminal over the directory it was given, and the tests run it over a
 * fake one with a temporary directory behind `WorkspaceContext`. Everything that
 * is not this tree -- the documents, saving, the dialogs, the keys -- is
 * `createEditor()`'s, in `editor.ts`. `examples/AGENTS.md` has the reasons, under
 * "A text editor with a Markdown preview".
 */

import { createEditor } from './editor.ts';
import { Preview } from './preview.ts';
import { keyHelp, Pane, Panel, TreeListView } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';

/**
 * The layout. Every colour is a role class the framework's sheet gives, so a
 * theme restyles all of it.
 */
export const stylesheet = `
  /* runApp() lets the root shrink to the screen */
  .app { flex-direction: column; flex-grow: 1 }
  .main { flex-direction: row; flex-grow: 1; min-height: 0 }
  .files { flex-grow: 1; min-width: 0 }
  .tree { flex-grow: 1; min-height: 0 }
  .source { flex-grow: 1; min-width: 0 }
  .areas { flex-direction: column; flex-grow: 1; min-height: 0 }
  .area { flex-grow: 1; min-height: 0 }
  .empty { flex-direction: column; flex-grow: 1; padding: 1 2 }
  .preview-panel { flex-grow: 1; min-width: 0 }
  .footer { flex-direction: row; height: 1; padding-left: 1; column-gap: 2 }
  /* what the editor last said keeps its width, and the keys give theirs up:
     "Saved" with the file name cut off says less than the last key listed */
  .status { flex-shrink: 0; white-space: nowrap }
  .palette { flex-direction: column; row-gap: 1 }
  .palette-row { flex-direction: row; column-gap: 2 }
  .palette-title { flex-direction: row; flex-grow: 1; min-width: 0 }
  .palette-keys { flex-shrink: 0 }
`;

/**
 * The file tree, the tabs and the text areas, the preview, and a footer of keys.
 *
 * @returns The screen.
 */
export function App(): Element {
  const e = createEditor();

  const tree = (
    <TreeListView
      empty="Nothing here"
      items={e.files}
      onActivate={e.activate}
      props={{ class: 'tree' }}
    />
  );
  const files = (
    <Panel class="files" title="Files">
      {tree}
    </Panel>
  );

  const tabs = <box class="tabs" />;
  const empty = (
    <box class="empty">
      <text class="sigil-muted">Pick a file in the tree and press Enter to open it.</text>
      <text class="sigil-muted">Ctrl-P lists every command.</text>
    </box>
  );
  const areas = <box class="areas">{empty}</box>;
  const source = (
    <Panel class="source" title={e.title}>
      {tabs}
      {areas}
    </Panel>
  );

  const preview = (
    <Pane class="preview-pane" edge="start" min={16} size={e.previewWidth}>
      <Panel class="preview-panel" title="Preview">
        <Preview source={e.previewSource} subject={e.previewSubject} />
      </Panel>
    </Pane>
  );

  const root = (
    <box class="app">
      <box class="main">
        <Pane max={60} min={16} size={e.sideWidth}>
          {files}
        </Pane>
        {source}
        {preview}
      </box>
      <box class="footer">
        {keyHelp(e.input)}
        <text class="status sigil-muted">{() => e.status.get()}</text>
      </box>
    </box>
  );

  e.attach({ areas, empty, panels: { files, source }, preview, root, tabs, tree });
  return root;
}
