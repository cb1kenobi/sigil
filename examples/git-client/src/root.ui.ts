/**
 * The git client's root component, in the `ui` tag.
 *
 * The same screen as `root.tsx` -- the same elements in the same order, though
 * not the same lines -- and the examples' smoke test asserts that the two draw
 * the same first screen. Everything that is not the tree is `createModel()`'s,
 * in `model.ts`, which neither root is.
 *
 * This one runs as it is: `node src/ui.ts` and nothing in between. A component
 * is interpolated rather than named (`<${ListView} />`), because a tag has no
 * scope to look a name up in; host elements stay bare. What it gives up is the
 * checking -- a misspelt prop is a runtime refusal rather than an editor's red
 * line, and `row` is handed items the types know nothing about, so its parameter
 * is annotated by hand.
 */

import { letterClasses } from './common.ts';
import { DiffPane } from './diff-pane.ts';
import { createModel } from './model.ts';
import type { Branch, Commit, FileChange } from './parse.ts';
import { keyHelp, ListView, Pane, Panel } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';

export { stylesheet } from './common.ts';

/**
 * Three lists down the left -- the files that changed, the branches, the log --
 * and a diff of whatever is selected on the right.
 *
 * @returns The screen.
 */
export function App(): Element {
  const m = createModel();

  const fileRow = (file: FileChange): Element => {
    const letters = letterClasses(file);
    return ui`
      <box class="row">
        <box class="letters">
          <text class=${letters.index}>${file.index}</text>
          <text class=${letters.worktree}>${file.worktree}</text>
        </box>
        <text class="grow">${file.path}</text>
      </box>
    `;
  };
  const files = ui`
    <${ListView}
      current=${m.fileCursor}
      empty=${() => ui`<text class="sigil-muted">${m.empty.files}</text>`}
      items=${m.files}
      key=${(file: FileChange) => file.path}
      onActivate=${m.open.files}
      props=${{ class: 'list' }}
      row=${fileRow}
      vim
    />
  `;

  const branchRow = (branch: Branch): Element => ui`
    <box class="row">
      <text class="letter sigil-success">${branch.current ? '*' : ' '}</text>
      <text class="grow">${branch.name}</text>
      <text class="fixed sigil-muted">${branch.track}</text>
    </box>
  `;
  const branches = ui`
    <${ListView}
      current=${m.branchCursor}
      empty=${() => ui`<text class="sigil-muted">${m.empty.branches}</text>`}
      items=${m.branches}
      key=${(branch: Branch) => branch.name}
      onActivate=${m.open.branches}
      props=${{ class: 'list' }}
      row=${branchRow}
      vim
    />
  `;

  const commitRow = (commit: Commit): Element => ui`
    <box class="row">
      <text class="fixed sigil-warn">${commit.short}</text>
      <text class="grow">${commit.subject}</text>
    </box>
  `;
  const commits = ui`
    <${ListView}
      current=${m.commitCursor}
      empty=${() => ui`<text class="sigil-muted">${m.empty.commits}</text>`}
      items=${m.commits}
      key=${(commit: Commit) => commit.sha}
      onActivate=${m.open.commits}
      props=${{ class: 'list' }}
      row=${commitRow}
      vim
    />
  `;
  const diff = ui`<${DiffPane} diff=${m.diff} />`;

  const panels = {
    branches: ui`
      <${Panel} class="branches" props=${{ onKey: m.keys.branches }} title=${m.titles.branches}>
        ${branches}
      </>
    `,
    commits: ui`
      <${Panel} class="commits" props=${{ onKey: m.keys.commits }} title=${m.titles.commits}>
        ${commits}
      </>
    `,
    diff: ui`
      <${Panel} class="diff" props=${{ onKey: m.keys.diff }} title=${m.titles.diff}>
        ${diff}
      </>
    `,
    files: ui`
      <${Panel}
        annotation=${m.status}
        class="files"
        props=${{ onKey: m.keys.files }}
        title=${m.titles.files}
      >
        ${files}
      </>
    `,
  };
  m.attach({ diff, lists: { branches, commits, files }, panels });

  return ui`
    <box class="app">
      <box class="main">
        <${Pane} max=${90} min=${24} size=${m.sideWidth}>
          <box class="side">
            ${panels.files}
            ${panels.branches}
            ${panels.commits}
          </box>
        </>
        ${panels.diff}
      </box>
      <box class="footer">${keyHelp(m.input)}</box>
    </box>
  `;
}
