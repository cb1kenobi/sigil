/**
 * The git client's root component, in JSX.
 *
 * `root.ui.ts` beside it is the same screen in the `ui` tag -- the same
 * elements in the same order, though not the same lines -- and the examples'
 * smoke test asserts that the two draw the same first screen. Everything that is
 * not the tree -- the states, the git calls, the keys and the dialogs -- is
 * `createModel()`'s, written once in `model.ts`, and this hands the parts its
 * keys reach back to it through `attach()`.
 *
 * JSX is what an editor can check: every prop of `ListView`, `Panel` and `Pane`
 * is typed, and `row` is checked against the items it is handed. What it costs
 * is a build: Node strips types and does not compile JSX, so this file only
 * ever runs as `sigil build` wrote it.
 */

import { letterClasses } from './common.ts';
import { DiffPane } from './diff-pane.ts';
import { createModel } from './model.ts';
import { keyHelp, ListView, Pane, Panel } from '@ttylabs/sigil/components';
import type { Element } from '@ttylabs/sigil/element';

export { stylesheet } from './common.ts';

/**
 * Three lists down the left -- the files that changed, the branches, the log --
 * and a diff of whatever is selected on the right.
 *
 * @returns The screen.
 */
export function App(): Element {
  const m = createModel();

  const files = (
    <ListView
      current={m.fileCursor}
      empty={() => <text class="sigil-muted">{m.empty.files}</text>}
      items={m.files}
      key={(file) => file.path}
      onActivate={m.open.files}
      props={{ class: 'list' }}
      row={(file) => {
        const letters = letterClasses(file);
        return (
          <box class="row">
            <box class="letters">
              <text class={letters.index}>{file.index}</text>
              <text class={letters.worktree}>{file.worktree}</text>
            </box>
            <text class="grow">{file.path}</text>
          </box>
        );
      }}
      vim
    />
  );
  const branches = (
    <ListView
      current={m.branchCursor}
      empty={() => <text class="sigil-muted">{m.empty.branches}</text>}
      items={m.branches}
      key={(branch) => branch.name}
      onActivate={m.open.branches}
      props={{ class: 'list' }}
      row={(branch) => (
        <box class="row">
          <text class="letter sigil-success">{branch.current ? '*' : ' '}</text>
          <text class="grow">{branch.name}</text>
          <text class="fixed sigil-muted">{branch.track}</text>
        </box>
      )}
      vim
    />
  );
  const commits = (
    <ListView
      current={m.commitCursor}
      empty={() => <text class="sigil-muted">{m.empty.commits}</text>}
      items={m.commits}
      key={(commit) => commit.sha}
      onActivate={m.open.commits}
      props={{ class: 'list' }}
      row={(commit) => (
        <box class="row">
          <text class="fixed sigil-warn">{commit.short}</text>
          <text class="grow">{commit.subject}</text>
        </box>
      )}
      vim
    />
  );
  const diff = <DiffPane diff={m.diff} />;

  const panels = {
    branches: (
      <Panel class="branches" props={{ onKey: m.keys.branches }} title={m.titles.branches}>
        {branches}
      </Panel>
    ),
    commits: (
      <Panel class="commits" props={{ onKey: m.keys.commits }} title={m.titles.commits}>
        {commits}
      </Panel>
    ),
    diff: (
      <Panel class="diff" props={{ onKey: m.keys.diff }} title={m.titles.diff}>
        {diff}
      </Panel>
    ),
    files: (
      <Panel
        annotation={m.status}
        class="files"
        props={{ onKey: m.keys.files }}
        title={m.titles.files}
      >
        {files}
      </Panel>
    ),
  };
  m.attach({ diff, lists: { branches, commits, files }, panels });

  return (
    <box class="app">
      <box class="main">
        <Pane max={90} min={24} size={m.sideWidth}>
          <box class="side">
            {panels.files}
            {panels.branches}
            {panels.commits}
          </box>
        </Pane>
        {panels.diff}
      </box>
      <box class="footer">{keyHelp(m.input)}</box>
    </box>
  );
}
