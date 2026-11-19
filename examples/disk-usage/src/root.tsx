/**
 * The visualizer's screen: the tree of what is under the root down the left,
 * largest first, and the treemap of the same tree on the right.
 *
 * Written in JSX, so `sigil build` compiles it and an editor checks every prop.
 * `App` is the whole screen, mounted by `runApp()`: `src/index.ts` runs it over the
 * directory it was given, and the tests run it over a temporary one behind
 * `DiskContext`. Everything that is not this tree -- the scan, the selection, the
 * keys, the delete -- is `createModel()`'s, in `model.ts`. `examples/AGENTS.md` has
 * the reasons, under "A disk space visualizer".
 */

import { formatSize } from './disk.ts';
import { MapView, Swatch } from './map-view.ts';
import { createModel } from './model.ts';
import { keyHelp, Panel, TreeListView } from '@ttylabs/sigil/components';
import { type Element, printable } from '@ttylabs/sigil/element';

/**
 * The layout. Every colour but the map's is a role class the framework's sheet
 * gives, so a theme restyles the rest; the map's are the file kinds', which
 * `map-view.ts` picks per colour level.
 *
 * The tree and the map share the width two to three: the map is the picture and
 * wants the room, and the tree needs enough for a name and a size -- which on a
 * narrow screen is half.
 */
export const stylesheet = `
  /* runApp() lets the root shrink to the screen */
  .app { flex-direction: column; flex-grow: 1 }
  .header { flex-direction: row; height: 1; padding: 0 1; column-gap: 2 }
  /* a long path gives way from its start, since its end is the directory */
  .path { flex-shrink: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis-start }
  .spacer { flex-grow: 1 }
  .totals { flex-shrink: 0; white-space: nowrap }
  .panes { flex-direction: row; flex-grow: 1; min-height: 0 }
  .files { flex-grow: 2; flex-basis: 0; min-width: 24 }
  .tree { flex-grow: 1; min-height: 0 }
  .map-panel { flex-grow: 3; flex-basis: 0; min-width: 0 }
  .row { flex-direction: row; flex-grow: 1; min-width: 0 }
  .name { flex-grow: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis }
  /* a size is never cut: the name gives way first */
  .size { flex-shrink: 0; width: 9; text-align: right }
  .info { height: 1; padding: 0 1; white-space: nowrap; text-overflow: ellipsis }
  .footer { flex-direction: row; height: 1; padding-left: 1; column-gap: 2 }
  /* what just happened keeps its width, and the keys give theirs up */
  .status { flex-shrink: 0; white-space: nowrap }
  .sigil-panel:focus-within { border-color: green }
  /* a narrow screen gives the tree half, since a name cut to its first letter
     says nothing, and a map half as wide still shows where the space went */
  @media (max-width: 90) {
    .files { flex-grow: 1 }
    .map-panel { flex-grow: 1 }
  }
`;

/**
 * The tree, the map, a line about the selection, and a footer of keys.
 *
 * @returns The screen.
 */
export function App(): Element {
  const m = createModel();

  const tree = (
    <TreeListView
      current={m.current}
      empty="Scanning..."
      expanded={m.expanded}
      items={m.items}
      onActivate={m.mapIt}
      props={{ class: 'tree' }}
      row={(choice) => {
        const node = m.nodeOf(choice);
        return (
          <box class="row">
            {node !== undefined && node.children === undefined ? (
              <Swatch category={node.category} />
            ) : (
              <box />
            )}
            <text class={`name${node?.kind === 'directory' ? ' sigil-info' : ''}`}>
              {printable(choice.text)}
            </text>
            <text class="size sigil-muted">{node === undefined ? '' : formatSize(node.bytes)}</text>
          </box>
        );
      }}
      vim
    />
  );
  const panel = (
    <Panel class="files" title="Files">
      {tree}
    </Panel>
  );

  const root = (
    <box class="app">
      <box class="header">
        <text class="path sigil-accent">{m.path}</text>
        <box class="spacer" />
        <text class="totals sigil-muted">{m.totals}</text>
      </box>
      <box class="panes">
        {panel}
        <Panel class="map-panel" title={m.mapTitle}>
          <MapView
            message={m.mapMessage}
            onHover={m.hover}
            onPick={m.pick}
            root={m.mapRoot}
            selected={m.current}
          />
        </Panel>
      </box>
      <text class="info">{m.info}</text>
      <box class="footer">
        <text class="status sigil-accent">{() => m.status.get()}</text>
        {keyHelp(m.input)}
      </box>
    </box>
  );

  m.attach({ panel, tree });
  return root;
}
