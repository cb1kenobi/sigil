/**
 * Everything the client does, which is everything but the tree it draws.
 *
 * The two root components, `root.tsx` and `root.ui.ts`, each build the same
 * screen in their own syntax and hand the parts that keys reach back here
 * through `attach()`. So the states, the git calls, the keys and the dialogs are
 * written once, in a module neither root is -- `root.ui.ts` runs unbuilt, and a
 * `.tsx` anywhere in its imports is a module Node cannot load. See "What the
 * twins share" in `examples/AGENTS.md`.
 */

import { type Git, GitContext } from './git.ts';
import {
  BRANCH_FORMAT,
  type Branch,
  type Commit,
  type FileChange,
  type Head,
  hunkPatch,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseStatus,
  type PatchFile,
  type PatchHunk,
  splitPatch,
} from './parse.ts';
import { useApp } from '@ttylabs/sigil/app';
import {
  confirmModal,
  describeListView,
  type NoteVariant,
  openModal,
  showToast,
  TextArea,
  TextField,
  unicodeSupported,
} from '@ttylabs/sigil/components';
import { box, type Element, text } from '@ttylabs/sigil/element';
import type { InputRouter, KeyEvent } from '@ttylabs/sigil/input';
import {
  createBranch,
  createEffect,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  useContext,
} from '@ttylabs/sigil/renderer';
import { Computed, State, untrack } from '@ttylabs/sigil/signals';

/** The four panes, by what they hold. */
export type PaneName = 'branches' | 'commits' | 'diff' | 'files';

/** A list pane, which is what the diff pane shows the selection of. */
export type Subject = 'branches' | 'commits' | 'files';

/** One run of the diff pane: a heading, some lines of prose, and patches. */
export interface DiffSection {
  /**
   * What Space does to a hunk of this section: stage it, unstage it, or nothing
   * for a commit, which is history.
   */
  readonly action?: 'stage' | 'unstage';
  /** An untracked file's text, drawn as one hunk of added lines. */
  readonly added?: { readonly path: string; readonly text: string };
  readonly files: readonly PatchFile[];
  /** The heading over it: `Unstaged`, `Staged`, a commit's hash. */
  readonly label: string;
  /** Prose under the heading, before any patch: a commit's message, a branch's log. */
  readonly lines: readonly string[];
  /** A path `added` or a binary file stands for, which is what Space stages whole. */
  readonly path?: string;
  /**
   * A staged rename's source, which unstaging the whole file has to reset along
   * with {@link path} -- or the deletion of the source stays staged and the
   * renamed file is left untracked.
   */
  readonly from?: string;
}

/** What the diff pane shows. */
export interface DiffContent {
  /** What it is a diff of, which also says when a rebuild is a new subject. */
  readonly key: string;
  /** Said when there are no sections: loading, nothing selected, no changes. */
  readonly note: string;
  readonly sections: readonly DiffSection[];
  /** The pane's title. */
  readonly title: string;
}

/** One hunk the cursor can be on, in the order the pane draws them. */
export interface HunkRef {
  readonly file?: PatchFile;
  readonly hunk?: PatchHunk;
  readonly section: DiffSection;
}

/** What `DiffPane()` reads and writes. */
export interface DiffState {
  readonly content: State<DiffContent>;
  /** Which of {@link hunks} the cursor is on. */
  readonly cursor: State<number>;
  /** Every hunk of the content, in order. */
  readonly hunks: Computed<readonly HunkRef[]>;
}

/** What the roots hand back once they have built the screen. */
export interface Parts {
  readonly diff: Element;
  readonly lists: {
    readonly branches: Element;
    readonly commits: Element;
    readonly files: Element;
  };
  readonly panels: Readonly<Record<PaneName, Element>>;
}

/** The model, as the roots read it. */
export interface Model {
  /** Hands the model the parts of the screen its keys and focus reach. */
  attach(parts: Parts): void;
  readonly branchCursor: State<string | undefined>;
  readonly branches: State<readonly Branch[]>;
  readonly commitCursor: State<string | undefined>;
  readonly commits: State<readonly Commit[]>;
  readonly diff: DiffState;
  /** What each list says while it has no rows, which changes once git has answered. */
  readonly empty: Readonly<Record<Subject, () => string>>;
  readonly fileCursor: State<string | undefined>;
  readonly files: State<readonly FileChange[]>;
  /** Where `HEAD` is. */
  readonly head: State<Head>;
  /** The router, which the footer reads. */
  readonly input: InputRouter;
  /** Each pane's own keys, for its panel's `onKey`. */
  readonly keys: Readonly<Record<PaneName, (event: KeyEvent) => void>>;
  /** Enter on a row, for each list's `onActivate`. */
  readonly open: Readonly<Record<Subject, () => void>>;
  /** How wide the left column is, which its edge drags. */
  readonly sideWidth: State<number>;
  /** The line at the right of the footer. */
  readonly status: () => string;
  /** Each pane's title. */
  readonly titles: Readonly<Record<PaneName, () => string>>;
}

/** How much of a patch is drawn before the rest is left out, in lines. */
const MAX_PATCH_LINES = 4000;

/** An untracked file larger than this is not read to be shown. */
const MAX_UNTRACKED_BYTES = 256 * 1024;

/** How many commits the log pane holds. */
const LOG_LENGTH = 300;

/** The arguments every patch is asked for with: git's own, for `git apply` to read back. */
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

const NOTHING: DiffContent = { key: '', note: '', sections: [], title: 'Diff' };

/**
 * Every hunk the cursor can be on, in the order the pane draws them: each hunk of
 * each file, and one for a whole file that has none to show -- an untracked file,
 * which is drawn as added, a binary one, or one too large to read -- since that is
 * still something Space can stage. A commit's hunks are here too, to move
 * through, and its section has no action.
 *
 * @param content - What the pane shows.
 * @returns The hunks.
 */
export function hunkRefs(content: DiffContent): HunkRef[] {
  return content.sections.flatMap((section): HunkRef[] => {
    if (section.added !== undefined) {
      return [{ section }];
    }
    if (!section.files.length) {
      return section.path === undefined ? [] : [{ section }];
    }
    return section.files.flatMap((file) =>
      file.hunks.length
        ? file.hunks.map((hunk) => ({ file, hunk, section }))
        : file.cut
          ? []
          : [{ file, section }]
    );
  });
}

/**
 * Builds the client's state, git calls and keys. Called once, from a root's body,
 * which is where the app and the context are there to be read.
 *
 * @returns The model.
 */
export function createModel(): Model {
  const app = useApp();
  // always there under `runApp()`, which refuses to call a component at all
  // without a terminal to read keys from -- typed as possibly missing for that
  const input = app.input as InputRouter;
  if (!input) {
    throw new Error('The git client needs keys: run it with runApp() on a terminal');
  }
  const git: Git = useContext(GitContext);

  // -- state ------------------------------------------------------------------
  const files = new State<readonly FileChange[]>([]);
  const branches = new State<readonly Branch[]>([]);
  const commits = new State<readonly Commit[]>([]);
  const head = new State<Head>({ ahead: 0, behind: 0, unborn: false });
  const fileCursor = new State<string | undefined>(undefined);
  const branchCursor = new State<string | undefined>(undefined);
  const commitCursor = new State<string | undefined>(undefined);
  // the left column starts at two fifths of the screen, which is about what
  // lazygit gives its side panels, and its edge drags it from there
  const sideWidth = new State(Math.min(60, Math.max(28, Math.round(app.terminal.width * 0.4))));
  /** The list the diff pane is showing the selection of: the last one focused. */
  const subject = new State<Subject>('files');
  /** Which pane has the focus, for the titles. */
  const active = new State<PaneName | undefined>(undefined);
  /** `undefined` until git first answers, then whether this is a repository. */
  const problem = new State<string | undefined>(undefined);
  const loaded = new State(false);
  const busy = new State(0);
  /** What the commit dialog holds between one opening and the next. */
  const draft = new State('');

  const content = new State<DiffContent>({ ...NOTHING, note: 'Loading...' });
  const cursor = new State(0);
  const hunks = new Computed<readonly HunkRef[]>(() => hunkRefs(content.get()));

  // -- running git, one call at a time ----------------------------------------
  // a key pressed twice quickly asks for two stagings, and two gits writing one
  // index at once is one of them failing on `index.lock` -- so every call waits
  // for the one before it, and a refresh reads what the action before it wrote
  const stop = new AbortController();
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(task: () => Promise<T>): Promise<T | undefined> => {
    const next = chain.then(async () => {
      if (disposed) {
        return undefined;
      }
      busy.set(busy.get() + 1);
      try {
        return await task();
      } finally {
        busy.set(busy.get() - 1);
      }
    });
    chain = next.catch(() => {});
    return next;
  };
  onCleanup(() => {
    disposed = true;
    // a git still running is killed rather than left to finish under a shell
    // that has the terminal back
    stop.abort();
  });

  /** Where git runs: the top of the repository, once it is known. */
  let root = git.cwd;
  const run = (args: readonly string[], stdin?: string): Promise<string> =>
    git.run(args, { cwd: root, input: stdin, signal: stop.signal });

  // a dialog is opened from a key, and a key handler runs with no owner, so
  // the effects of a field built there -- a `TextArea` over the draft -- would
  // never be disposed and would go on following the draft after the dialog had
  // closed. So its body is built under a branch of the component's owner, which
  // the dialog disposes when it settles. SIG-335 is the ticket for `openModal()`
  // doing this itself
  const owner = getOwner();
  const owned = <T>(build: () => T): { dispose: () => void; value: T } => {
    const branch = runWithOwner(owner, createBranch);
    return { dispose: branch.dispose, value: runWithOwner(branch.owner, build) };
  };

  // -- what the app says ------------------------------------------------------
  const toast = (message: string, variant: NoteVariant = 'success'): void => {
    if (!disposed) {
      showToast(app.view, { message, variant, width: 40 });
    }
  };
  const failed = (err: unknown): void => {
    if (!disposed && (err as Error).name !== 'AbortError') {
      toast((err as Error).message, 'error');
    }
  };

  // -- reading the repository -------------------------------------------------
  const readRepository = async (): Promise<void> => {
    if (problem.get() !== '') {
      try {
        root = (await git.run(['rev-parse', '--show-toplevel'], { signal: stop.signal })).trim();
        problem.set('');
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return;
        }
        // git's own line, without its `fatal:`, which reads as the app dying
        const said = ((err as Error).message.split('\n')[0] ?? '').replace(/^fatal: /, '');
        problem.set(said || 'not a git repository');
        loaded.set(true);
        return;
      }
    }
    const status = parseStatus(
      await run(['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all'])
    );
    const refs = parseBranches(
      await run(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'])
    );
    const log = status.head.unborn
      ? []
      : parseLog(await run(['log', '-z', `-n${LOG_LENGTH}`, `--format=${LOG_FORMAT}`, 'HEAD']));
    if (disposed) {
      return;
    }
    head.set(status.head);
    files.set(status.files);
    // the branch cursor starts on the branch checked out, rather than on the
    // first by name: set before the rows arrive, so the list finds it there
    if (untrack(() => branchCursor.get()) === undefined) {
      branchCursor.set(refs.find((it) => it.current)?.name);
    }
    branches.set(refs);
    commits.set(log);
    loaded.set(true);
  };

  /** Reads everything again, and the diff after it. */
  const refresh = (): Promise<void> =>
    queue(readRepository)
      .catch(failed)
      .then(() => {
        diffWanted();
      });

  // -- the diff ---------------------------------------------------------------
  let diffQueued = false;
  /** Asks for the diff of the current selection, once however many times it is asked. */
  const diffWanted = (): void => {
    if (diffQueued) {
      return;
    }
    diffQueued = true;
    void queue(async () => {
      diffQueued = false;
      const next = await readDiff();
      if (!disposed) {
        if (next.key !== untrack(() => content.get().key)) {
          cursor.set(0);
        }
        content.set(next);
        const count = untrack(() => hunks.get().length);
        if (untrack(() => cursor.get()) >= count) {
          cursor.set(Math.max(0, count - 1));
        }
      }
    }).catch(failed);
  };

  /** The patch of `git diff` with these arguments, read into files. */
  const patch = async (args: readonly string[]): Promise<PatchFile[]> =>
    readPatch(await run(['diff', ...DIFF, ...args]));

  const readDiff = async (): Promise<DiffContent> => {
    if (problem.get()) {
      return { ...NOTHING, note: 'Run it inside a repository, or name one: git-client <dir>' };
    }
    switch (untrack(() => subject.get())) {
      case 'files':
        return readFileDiff();
      case 'branches':
        return readBranchLog();
      case 'commits':
        return readCommit();
    }
  };

  const readFileDiff = async (): Promise<DiffContent> => {
    const path = untrack(() => fileCursor.get());
    const file = untrack(() => files.get()).find((it) => it.path === path);
    if (!file) {
      return { ...NOTHING, key: 'files', note: 'No changes: the working tree is clean' };
    }
    const key = `file:${file.path}`;
    const title = file.path;
    if (file.conflicted) {
      return {
        key,
        note: 'In conflict: resolve it in an editor, then Space marks it resolved',
        sections: [],
        title,
      };
    }
    if (file.untracked) {
      const bytes = await git.readFile(joinPath(root, file.path), MAX_UNTRACKED_BYTES);
      if (bytes === undefined || bytes.includes(0)) {
        const why = bytes === undefined ? 'too large to show' : 'binary';
        return {
          key,
          note: '',
          sections: [
            {
              action: 'stage',
              files: [],
              label: 'Untracked',
              lines: [`${file.path} is ${why}: Space stages it whole`],
              path: file.path,
            },
          ],
          title,
        };
      }
      return {
        key,
        note: '',
        sections: [
          {
            action: 'stage',
            added: { path: file.path, text: bytes.toString('utf8') },
            files: [],
            label: 'Untracked',
            lines: [],
            path: file.path,
          },
        ],
        title,
      };
    }
    const paths = file.from === undefined ? [file.path] : [file.path, file.from];
    const sections: DiffSection[] = [];
    if (file.unstaged) {
      sections.push({
        action: 'stage',
        files: await patch(['--', ...paths]),
        label: 'Unstaged',
        lines: [],
        path: file.path,
      });
    }
    if (file.staged) {
      sections.push({
        action: 'unstage',
        files: await patch(['--cached', '-M', '--', ...paths]),
        from: file.from,
        label: 'Staged',
        lines: [],
        path: file.path,
      });
    }
    return { key, note: 'No changes', sections, title };
  };

  const readBranchLog = async (): Promise<DiffContent> => {
    const name = untrack(() => branchCursor.get());
    if (name === undefined) {
      return { ...NOTHING, key: 'branches', note: 'No branches yet' };
    }
    const log = parseLog(
      await run(['log', '-z', '-n50', `--format=${LOG_FORMAT}`, `refs/heads/${name}`, '--'])
    );
    return {
      key: `branch:${name}`,
      note: '',
      sections: [
        {
          files: [],
          label: `Log of ${name}`,
          lines: log.map((c) => `${c.short} ${c.subject} (${c.when}, ${c.author})`),
        },
      ],
      title: name,
    };
  };

  const readCommit = async (): Promise<DiffContent> => {
    const sha = untrack(() => commitCursor.get());
    if (sha === undefined) {
      return { ...NOTHING, key: 'commits', note: 'No commits yet' };
    }
    const message = await run(['show', '-s', '--format=Author: %an <%ae>%nDate:   %ad%n%n%B', sha]);
    const files = readPatch(await run(['show', ...DIFF, '--format=', '--patch', '-M', sha, '--']));
    return {
      key: `commit:${sha}`,
      note: '',
      sections: [
        {
          files,
          label: `commit ${sha}`,
          lines: message.replace(/\s+$/, '').split('\n'),
        },
      ],
      title: sha.slice(0, 12),
    };
  };

  // -- actions ----------------------------------------------------------------
  /**
   * Runs a change to the repository, then reads it again whatever happened, and
   * says how it went.
   */
  const act = (task: () => Promise<string | undefined>): Promise<void> =>
    queue(task)
      .then((said) => {
        if (said) {
          toast(said);
        }
      }, failed)
      .then(refresh);

  const currentFile = (): FileChange | undefined =>
    files.get().find((it) => it.path === fileCursor.get());
  const currentBranch = (): Branch | undefined =>
    branches.get().find((it) => it.name === branchCursor.get());

  const toggleFile = (): void => {
    const file = currentFile();
    if (!file) {
      return;
    }
    void act(async () => {
      if (file.unstaged) {
        await run(['add', '--', file.path]);
        return file.conflicted ? `Marked ${file.path} resolved` : `Staged ${file.path}`;
      }
      const paths = file.from === undefined ? [file.path] : [file.path, file.from];
      await run(['reset', '-q', '--', ...paths]);
      return `Unstaged ${file.path}`;
    });
  };

  const toggleAll = (): void => {
    const all = files.get();
    if (!all.length) {
      return;
    }
    const anyUnstaged = all.some((it) => it.unstaged);
    void act(async () => {
      if (anyUnstaged) {
        await run(['add', '--all']);
        return 'Staged everything';
      }
      await run(['reset', '-q']);
      return 'Unstaged everything';
    });
  };

  const discardFile = async (): Promise<void> => {
    const file = currentFile();
    if (!file) {
      return;
    }
    if (file.conflicted) {
      toast(`${file.path} is in conflict: resolve it rather than discard it`, 'warning');
      return;
    }
    if (!file.unstaged) {
      toast(`Nothing unstaged in ${file.path}: unstage it first`, 'warning');
      return;
    }
    const yes = await confirmModal(app.view, {
      initial: 'no',
      input,
      message: file.untracked
        ? `Delete ${file.path}? It is untracked, so git has no copy of it.`
        : `Discard the unstaged changes to ${file.path}? Staged changes are kept.`,
      title: file.untracked ? 'Delete file' : 'Discard changes',
      yes: file.untracked ? 'Delete' : 'Discard',
    });
    if (!yes) {
      return;
    }
    await act(async () => {
      if (file.untracked) {
        await run(['clean', '-f', '-q', '--', file.path]);
        return `Deleted ${file.path}`;
      }
      await run(['checkout', '--', file.path]);
      return `Discarded the changes to ${file.path}`;
    });
  };

  const toggleHunk = (): void => {
    const at = hunks.get()[cursor.get()];
    const action = at?.section.action;
    if (!at || !action) {
      return;
    }
    void act(async () => {
      if (!at.hunk) {
        // an untracked file, one binary or too large to show, or a rename with
        // no content changes: all of it, and a rename's source with it, the way
        // `toggleFile()` resets both
        const path = at.file?.path ?? at.section.path ?? '';
        const from = at.section.from;
        await run(
          action === 'stage'
            ? ['add', '--', path]
            : ['reset', '-q', '--', path, ...(from === undefined ? [] : [from])]
        );
        return `${action === 'stage' ? 'Staged' : 'Unstaged'} ${path}`;
      }
      if (!at.file) {
        return undefined;
      }
      const args = ['apply', '--cached', '--whitespace=nowarn'];
      await run(
        action === 'unstage' ? [...args, '--reverse', '-'] : [...args, '-'],
        hunkPatch(at.file, at.hunk)
      );
      return `${action === 'stage' ? 'Staged' : 'Unstaged'} a hunk of ${at.file.path}`;
    });
  };

  const moveHunk = (by: number): void => {
    const count = hunks.get().length;
    if (count) {
      cursor.set(Math.min(count - 1, Math.max(0, cursor.get() + by)));
    }
  };

  const checkout = (): void => {
    const branch = currentBranch();
    if (!branch || branch.current) {
      return;
    }
    void act(async () => {
      await run(['switch', '--no-guess', branch.name]);
      return `Switched to ${branch.name}`;
    });
  };

  /** Asks for a line in a dialog, and settles with it or with nothing for a cancel. */
  const ask = async (
    title: string,
    placeholder: string,
    action: string
  ): Promise<string | undefined> => {
    const value = new State('');
    let close: (yes: boolean) => void = () => {};
    const { dispose, value: field } = owned(() =>
      TextField({ onSubmit: () => close(true), placeholder, value })
    );
    const dialog = openModal<boolean>(app.view, {
      actions: [
        { label: action, value: true },
        { label: 'Cancel', value: false },
      ],
      body: field,
      input,
      title,
    });
    close = (yes) => dialog.close(yes);
    // `initial` names a button, so the field is focused once the dialog is open:
    // SIG-337 is the ticket for a dialog that opens on a field in its body
    input.focus.focus(field);
    const answer = await dialog.result;
    dispose();
    return answer ? value.get().trim() : undefined;
  };

  const newBranch = async (): Promise<void> => {
    if (problem.get()) {
      return;
    }
    const name = await ask('New branch', 'name, from HEAD', 'Create');
    if (!name) {
      return;
    }
    await act(async () => {
      await run(['switch', '-c', name]);
      return `Created and switched to ${name}`;
    });
  };

  const deleteBranch = async (): Promise<void> => {
    const branch = currentBranch();
    if (!branch) {
      return;
    }
    if (branch.current) {
      toast(`${branch.name} is checked out: switch to another branch first`, 'warning');
      return;
    }
    const yes = await confirmModal(app.view, {
      initial: 'no',
      input,
      message: `Delete the branch ${branch.name}? git refuses if it is not merged.`,
      title: 'Delete branch',
      yes: 'Delete',
    });
    if (!yes) {
      return;
    }
    await act(async () => {
      await run(['branch', '-d', '--', branch.name]);
      return `Deleted ${branch.name}`;
    });
  };

  const commit = async (): Promise<void> => {
    if (problem.get()) {
      return;
    }
    if (!files.get().some((it) => it.staged)) {
      toast('Nothing is staged: Space on a file stages it', 'warning');
      return;
    }
    let close: (yes: boolean) => void = () => {};
    const built = owned(() => {
      const area = TextArea({
        placeholder: 'What this commit does',
        props: { height: 6 },
        value: draft,
      });
      return {
        area,
        body: box(
          { 'flex-direction': 'column' },
          area,
          text('Ctrl-S commits · Esc keeps the draft for later', {
            class: 'sigil-muted',
            'margin-top': 1,
          })
        ),
      };
    });
    const { area, body } = built.value;
    // Enter is a newline in the area, so the commit has a key of its own. The
    // dialog hands a key to the focused element and its ancestors up to its
    // panel, so the box around the area hears what the area leaves alone
    body.onKey = (event) => {
      if (event.key.ctrl && event.key.name === 's') {
        event.stop();
        close(true);
      }
    };
    const dialog = openModal<boolean>(app.view, {
      actions: [
        { label: 'Commit', value: true },
        { label: 'Cancel', value: false },
      ],
      body,
      input,
      title: 'Commit',
      width: 64,
    });
    close = (yes) => dialog.close(yes);
    input.focus.focus(area);
    const answer = await dialog.result;
    built.dispose();
    if (!answer) {
      return;
    }
    const message = draft.get().trim();
    if (!message) {
      toast('An empty message: nothing committed', 'warning');
      return;
    }
    await act(async () => {
      await run(['commit', '--quiet', '--cleanup=whitespace', '-F', '-'], `${message}\n`);
      draft.set('');
      const [made] = parseLog(await run(['log', '-z', '-n1', `--format=${LOG_FORMAT}`, 'HEAD']));
      return made ? `Committed ${made.short}: ${made.subject}` : 'Committed';
    });
  };

  // -- the parts the keys reach -----------------------------------------------
  let parts: Parts | undefined;

  const focusPane = (name: PaneName): void => {
    if (!parts) {
      return;
    }
    input.focus.focus(name === 'diff' ? parts.diff : parts.lists[name]);
  };

  const keys: Record<PaneName, (event: KeyEvent) => void> = {
    branches: (event) => {
      const name = event.key.name;
      if (name === 'space') {
        checkout();
      } else if (name === 'n') {
        void newBranch();
      } else if (name === 'D') {
        void deleteBranch();
      } else {
        return;
      }
      event.stop();
    },
    commits: () => {},
    diff: (event) => {
      const name = event.key.name;
      if (name === 'space') {
        toggleHunk();
      } else if (name === ']' || name === 'n') {
        moveHunk(1);
      } else if (name === '[' || name === 'p') {
        moveHunk(-1);
      } else if (name === 'escape') {
        focusPane(subject.get());
      } else {
        return;
      }
      event.stop();
    },
    files: (event) => {
      const name = event.key.name;
      if (name === 'space') {
        toggleFile();
      } else if (name === 'a') {
        toggleAll();
      } else if (name === 'd') {
        void discardFile();
      } else {
        return;
      }
      event.stop();
    },
  };

  const attach = (given: Parts): void => {
    parts = given;
    const { lists, panels } = given;

    // the footer follows the focus: each pane's keys are described with its
    // panel as the scope, so they are listed while the focus is inside it
    const off: (() => void)[] = [];
    const say = (pane: PaneName, spec: string, description: string, priority = 3): void => {
      off.push(input.describe(spec, { description, priority, scope: panels[pane] }));
    };
    say('files', 'space', 'stage');
    say('files', 'a', 'all');
    say('files', 'd', 'discard');
    say('branches', 'space', 'checkout');
    say('branches', 'n', 'new');
    say('branches', 'D', 'delete');
    say('diff', 'space', 'stage hunk');
    say('diff', ']', 'next hunk', 2);
    say('diff', '[', 'previous hunk', 2);
    say('diff', 'escape', 'back', 1);
    off.push(describeListView(input, lists.files, lists.branches, lists.commits));

    // the app's own keys are fallbacks: they come after the focused element, so
    // a letter typed into a dialog's field is a letter, and they run with nothing
    // focused. `q` is not here: `runApp()` binds it the same way (`quitKey`)
    const key = (spec: string, fn: () => void, description?: string, priority = 2): void => {
      off.push(input.fallback(spec, fn, description ? { description, priority } : undefined));
    };
    key('c', () => void commit(), 'commit');
    key('r', () => void refresh(), 'refresh', 1);
    // one description, so the footer lists them as one line: `1/2/3/4 pane`
    key('1', () => focusPane('files'), 'pane', 0);
    key('2', () => focusPane('branches'), 'pane', 0);
    key('3', () => focusPane('commits'), 'pane', 0);
    key('4', () => focusPane('diff'), 'pane', 0);
    onCleanup(() => {
      for (const fn of off) {
        fn();
      }
    });

    // which pane has the focus: its panel is lit, and a list that takes it is
    // what the diff pane shows from then on. A class rather than a selector,
    // because there is no `:focus-within` (SIG-372)
    createEffect(() => {
      const focused = input.focus.current.get();
      let found: PaneName | undefined;
      for (const name of ['files', 'branches', 'commits', 'diff'] as const) {
        const on = focused !== undefined && panels[name].contains(focused);
        panels[name].toggleClass('is-active', on);
        if (on) {
          found = name;
        }
      }
      active.set(found);
      if (found !== undefined && found !== 'diff' && found !== untrack(() => subject.get())) {
        subject.set(found);
      }
    });

    // the diff follows the selection of whichever list it is showing
    createEffect(() => {
      subject.get();
      fileCursor.get();
      branchCursor.get();
      commitCursor.get();
      diffWanted();
    });

    onMount(() => input.focus.focus(lists.files));
  };

  void refresh();

  // -- what the roots read ----------------------------------------------------
  const count = (n: number): string => (n ? ` · ${n}` : '');
  // the pane with the focus says so in its title as well as its border, which is
  // what is left of it at colour level 0
  const pointer = unicodeSupported() ? '▸ ' : '> ';
  const mark = (name: PaneName): string => (active.get() === name ? pointer : '');

  return {
    attach,
    branchCursor,
    branches,
    commitCursor,
    commits,
    diff: { content, cursor, hunks },
    empty: {
      // the problem is said once, in the first pane, rather than three times
      branches: () => (problem.get() ? '' : loaded.get() ? 'No branches yet' : 'Loading...'),
      commits: () => (problem.get() ? '' : loaded.get() ? 'No commits yet' : 'Loading...'),
      files: () => problem.get() || (loaded.get() ? 'Clean: nothing to commit' : 'Loading...'),
    },
    fileCursor,
    files,
    head,
    input,
    keys,
    open: {
      branches: checkout,
      commits: () => focusPane('diff'),
      files: () => focusPane('diff'),
    },
    sideWidth,
    status: () => {
      const at = head.get();
      const where = problem.get()
        ? ''
        : at.branch === undefined
          ? loaded.get()
            ? 'HEAD detached'
            : ''
          : `${at.branch}${at.unborn ? ' (no commits yet)' : ''}${at.ahead ? ` ↑${at.ahead}` : ''}${at.behind ? ` ↓${at.behind}` : ''}`;
      return busy.get() ? `${where} · working...` : where;
    },
    titles: {
      branches: () => `${mark('branches')}[2] Branches${count(branches.get().length)}`,
      commits: () => `${mark('commits')}[3] Commits${count(commits.get().length)}`,
      diff: () => `${mark('diff')}[4] ${content.get().title}`,
      files: () => `${mark('files')}[1] Files${count(files.get().length)}`,
    },
  };
}

/**
 * A patch read into files, cut short at {@link MAX_PATCH_LINES} so that a
 * vendored file or a lockfile does not build a hundred thousand rows.
 *
 * Cut at a line, and then the hunk the cut went through is dropped as well:
 * its header still counts every line it had, so it is not a hunk `git apply`
 * would take, and showing it would offer Space on a hunk that cannot be staged.
 * What is left out is said, in the file's header, which `diffView()` skips and
 * so is drawn by nobody -- the pane says it instead, from `cut`.
 *
 * @param patch - What git printed.
 * @returns The files, whole or cut.
 */
function readPatch(patch: string): PatchFile[] {
  let at = -1;
  for (let n = 0; n < MAX_PATCH_LINES; n++) {
    at = patch.indexOf('\n', at + 1);
    if (at === -1) {
      return splitPatch(patch);
    }
  }
  const files = splitPatch(patch.slice(0, at + 1));
  const last = files.at(-1);
  if (last !== undefined) {
    files[files.length - 1] = { ...last, cut: true, hunks: last.hunks.slice(0, -1) };
  }
  return files;
}

/**
 * A path of the working tree, from the top of the repository and the path git
 * printed. Git prints `/` on every platform and Windows takes it, so the two are
 * joined with one rather than through `node:path`, which would make it `\` --
 * correct, and a second spelling of one path.
 *
 * @param top - The top of the repository, as `rev-parse --show-toplevel` said it.
 * @param path - The path git printed.
 * @returns The path.
 */
function joinPath(top: string, path: string): string {
  return `${top.replace(/\/+$/, '')}/${path}`;
}
