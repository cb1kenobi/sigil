/**
 * A REPL: a prompt line that comes back, with history, completion and a footer.
 *
 * Node's `repl` gives a prompt with history and a completion list printed under
 * it, and nowhere to say anything else. This is the same prompt drawn as a
 * component: an editable line, a popup of completions anchored at the word being
 * completed, a dim suggestion after the caret, and a footer the caller fills from
 * the line. It knows nothing about a parser -- `commandRepl()` is where a schema
 * meets it.
 *
 * ```js
 * import { repl, wordCompleter } from '@ttylabs/sigil/components/repl';
 *
 * await repl({
 *   prompt: 'deploy> ',
 *   completer: wordCompleter(['deploy', 'status', 'rollback']),
 *   historyFile: replHistoryFile('mycli'),
 *   footer: (line) => (line.startsWith('deploy') ? 'deploy <env>' : undefined),
 *   onSubmit: async (line, { exit }) => {
 *     if (line === 'quit') {
 *       exit();
 *     } else {
 *       console.log(`ran ${line}`);
 *     }
 *   },
 * });
 * ```
 *
 * **Inline first.** `repl()` draws in a live region at the bottom of the scrollback,
 * the way every prompt here does, and what a command prints goes above it and stays
 * -- as it does in `node`. **The same component is `Repl()`**, an element a layout
 * holds: a full-screen app places it in a column and owns what happens on submit.
 * There is one implementation; the facade is `createRepl()` mounted over an inline
 * canvas, once per line.
 *
 * Per line, rather than one region for the session: the line is a prompt like any
 * other, and when it is submitted it is left in the scrollback as typed and the
 * region is given up. A command that then calls `runApp()`, a prompt or `spawn()`
 * finds the terminal free, so there is nothing to suspend and nothing to evict --
 * and the terminal's own rule (a second claim on the live region evicts the first)
 * still covers the one case left, a prompt raised by a timer while the line is up.
 *
 * `AGENTS.md` has the reasons under "A REPL".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import {
  canReadKeys,
  createInput,
  hiddenBySheet,
  type InputStream,
  type Key,
  type KeyEvent,
  type PasteEvent,
} from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { errorMessage } from '../util/error-message.js';
import { stringWidth } from '../width/index.js';
import type { AutocompleteRangeSource } from './autocomplete.js';
import { captureConsole, createLogRing, type LogEntry } from './console-capture.js';
import {
  boundary,
  deleteAfter,
  type Edit,
  editLine,
  insertAt,
  pastedLine,
  typedText,
} from './editing.js';
import { fuzzyMatch, highlightRuns, rankBy } from './fuzzy.js';
import { keyHelp } from './key-help.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import {
  type AccessibleOptions,
  type Choice,
  listWindow,
  promptAsLines,
  promptChoice,
  PROMPT_SYMBOLS,
  promptKeys,
  promptValue,
  promptWindow,
} from './prompt.js';
import { createHistory, type History } from './repl-history.js';

/** Why a REPL ended: Ctrl-C twice on an empty line, or Ctrl-D on one. */
export type ReplExit = 'eof' | 'interrupt';

/** What a footer is: a line of text, an element, or nothing. */
export type ReplFooter = string | Element | undefined;

export interface ReplProps {
  /**
   * Where the line goes on from when it is cut at the end of a row. Defaults to
   * `'... '`, which is `node`'s.
   */
  continuation?: string;
  /**
   * What is on offer for the word at the caret.
   *
   * Asked after every edit with the line, the caret and a signal that is aborted
   * the moment the line changes again, so a slow provider never has its answer
   * applied to a line it was not asked about. A provider that answers at once is
   * applied at once; one that returns a promise has the popup closed until it
   * lands. A throw or a rejection closes the popup and goes to `onError`.
   *
   * With a `isContinued()` buffer the line is every line typed so far, joined
   * with `\n`, and the offsets are into that.
   */
  completer?: AutocompleteRangeSource;
  /**
   * A line under the prompt, worked out from what is typed.
   *
   * Called in an effect with the whole line and the caret, so whatever signals it
   * reads are watched too and the footer follows them: a type read off a state
   * the app updates, a usage line, a count. A string is drawn dim, an element as
   * it is, `undefined` is no footer.
   */
  footer?: (line: string, cursor: number) => ReplFooter;
  /**
   * Whether to list the keys under the line, as the prompts' footer does.
   * Defaults to `false`.
   */
  help?: boolean;
  /**
   * Where earlier lines are kept. A {@link History} is shared with whoever else
   * holds it; without one the REPL keeps its own in memory.
   */
  history?: History;
  /**
   * Whether a line is not finished, so Enter starts another instead of submitting.
   *
   * Given the whole text so far, with the lines joined by `\n`. There is no bracket
   * or quote matching in the REPL: what counts as finished is the app's language
   * and not ours. May be async. A line it throws on is submitted.
   */
  isContinued?: (line: string) => boolean | Promise<boolean>;
  /** How many completions the popup lists at once. Defaults to 8. */
  maxItems?: number;
  /** Called with the line after every edit that changed it. */
  onChange?: (line: string) => void;
  /**
   * Called with what `completer` or an async `onSubmit` threw. Defaults to
   * `console.error`, which an inline REPL writes above its region.
   */
  onError?: (error: unknown) => void;
  /**
   * Called when the REPL is told to end -- a second Ctrl-C, or Ctrl-D on an empty
   * line. Without it those keys are not the REPL's and go on to whatever is
   * around it, so a layout's own quit still works.
   */
  onExit?: (reason: ReplExit) => void;
  /**
   * Called with the line when Enter finishes it.
   *
   * What the app does with it is the app's. A promise is waited for: the line is
   * cleared at once and keys are held until it settles, and the prompt then comes
   * back. A blank line is not submitted unless `submitBlank` says so.
   */
  onSubmit: (line: string) => unknown;
  /** The host box's own props: a class, a margin, a `flex-grow`. Geometry only. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onPaste' | 'onResize'>;
  /** What is drawn before the line. Defaults to `'> '`. */
  prompt?: string;
  /** Whether a blank line is submitted. Defaults to `false`. */
  submitBlank?: boolean;
  /**
   * Whether the best completion is shown dim after the caret, for Right or End to
   * accept. Defaults to `true`.
   */
  suggest?: boolean;
  /**
   * The line. A string is where it starts; a `State<string>` is the line itself:
   * the keys write it, and a write the app makes replaces it, with the caret at
   * the end. Defaults to empty.
   */
  value?: string | State<string>;
  /**
   * How many columns the line takes. Defaults to what the layout gives it.
   */
  width?: number;
}

/** What `createRepl()` hands back: the element, and what a runner needs of it. */
export interface ReplController {
  /** The host element, which is the focusable one. */
  readonly element: Element;
  /** The history lines are kept in. */
  readonly history: History;
  /** The line, as a signal the app may also write. */
  readonly line: State<string>;
  /**
   * Freezes the component as left in the scrollback: the prompt and the text, no
   * caret, no popup, no footer, and no key taken. Called once a line is over.
   */
  settle(): void;
}

/** A completion on offer, as it is listed and as it is inserted. */
interface Offer {
  readonly hint: string | undefined;
  readonly label: string;
  readonly matched: readonly number[];
  /** What goes where the range was. */
  readonly text: string;
}

/** A control character, which the keys cannot type but an app can write. */
const CONTROL = /\p{Cc}/gu;

/** The columns a popup row's pointer takes, in front of its label. */
const POINTER = 2;

/** How many completions the popup lists when nobody says. */
const MAX_ITEMS = 8;

/** A search of the history that is being typed. */
interface Search {
  /** Where the match is in the entries, or `-1` for none. */
  at: number;
  /** What was typed. */
  query: string;
  /** The line as it was, for Escape to put back. */
  saved: { held: readonly string[]; value: string; cursor: number };
}

/**
 * Builds a REPL line as an element, and the handle a runner needs.
 *
 * @param props - What to complete, where to keep history, and what to do on Enter.
 * @returns The controller.
 */
export function createRepl(props: ReplProps): ReplController {
  refuseOwnedHooks('Repl', props.props, ['onKey', 'onPaste', 'onFocusChange', 'onResize']);
  if (typeof props.onSubmit !== 'function') {
    throw new TypeError('Expected a REPL onSubmit to be a function');
  }
  if (
    props.value !== undefined &&
    typeof props.value !== 'string' &&
    !(props.value instanceof State)
  ) {
    throw new TypeError('Expected a REPL value to be a string or a State');
  }
  if (props.maxItems !== undefined && !(Number.isInteger(props.maxItems) && props.maxItems > 0)) {
    throw new TypeError('Expected a REPL maxItems to be a positive whole number');
  }
  if (props.width !== undefined && !(Number.isInteger(props.width) && props.width > 0)) {
    throw new TypeError('Expected a REPL width to be a positive whole number');
  }

  const history = props.history ?? createHistory();
  const prompt = props.prompt ?? '> ';
  const continuation = props.continuation ?? '... ';
  const maxItems = props.maxItems ?? MAX_ITEMS;
  const suggest = props.suggest ?? true;
  const value = props.value instanceof State ? props.value : new State(props.value ?? '');
  const cursorSignal = new State(0);
  const heldSignal = new State<readonly string[]>([]);

  // --- state ---
  /** The caret, as an offset into the line being edited (not the lines held above it). */
  let cursor = value.get().length;
  cursorSignal.set(cursor);
  /** What the line was as of the last draw, so a write the app made is told apart. */
  let seen = value.get();
  /** The lines already ended with `isContinued()`, above the one being edited. */
  let held: string[] = [];
  /** Where in the history the line was recalled from, or `undefined` for what was typed. */
  let browsing: number | undefined;
  /** What was typed before the history was walked, which Down past the newest restores. */
  let draft: { held: string[]; value: string } | undefined;
  let search: Search | undefined;
  let offers: Offer[] = [];
  /** The range the offers replace, in the line being edited. */
  let range = { from: 0, to: 0 };
  let active = -1;
  let top = 0;
  /** Whether Escape has put the popup away until the next edit. */
  let dismissed = false;
  /** Whether Tab asked, so a lone answer is taken rather than listed. */
  let forced = false;
  let controller: AbortController | undefined;
  let armed = false;
  let notice: string | undefined;
  let busy = false;
  let settled = false;
  let room = props.width ?? Number.POSITIVE_INFINITY;
  let columns = props.width ?? Number.POSITIVE_INFINITY;
  let drawn = '';
  /** What the popup's rows say, so they are rebuilt only when that changes. */
  let popupRows = '';

  // --- the tree ---
  const heldBox = box({ class: 'sigil-repl-held', 'flex-direction': 'column' });
  const promptNode = textNode(prompt, {
    class: 'sigil-repl-prompt sigil-accent',
    'flex-shrink': 0,
    'white-space': 'nowrap',
  });
  const before = textNode('', { class: 'sigil-repl-before', 'white-space': 'nowrap' });
  const caret = textNode('', { class: 'sigil-repl-caret', 'white-space': 'nowrap' });
  const after = textNode('', { class: 'sigil-repl-after', 'white-space': 'nowrap' });
  const field = box(
    {
      class: 'sigil-repl-field',
      'flex-direction': 'row',
      'flex-grow': 1,
      'min-width': 0,
      overflow: 'hidden',
    },
    before,
    caret,
    after
  );
  const row = box({ class: 'sigil-repl-line', 'flex-direction': 'row' }, promptNode, field);
  const popup = box({
    class: 'sigil-repl-popup',
    'flex-direction': 'column',
    'flex-shrink': 0,
  });
  const noticeNode = textNode('', { class: 'sigil-repl-notice sigil-muted', display: 'none' });
  const footerSlot = box({ class: 'sigil-repl-footer', 'flex-direction': 'column' });

  // one table for the keys the REPL answers by name: it is what dispatches them,
  // and what the footer lists, so the two cannot disagree about a key
  const keys = promptKeys<boolean>();
  const hasLine = (): boolean => held.length > 0 || value.get() !== '';
  const ghostText = (): string | undefined => ghost()?.text;
  const popupOpen = (): boolean => offers.length > 0 && !dismissed && search === undefined;

  keys.on('enter', () => submit(), { description: __`run`, priority: 5 });
  if (props.completer !== undefined) {
    keys.on('tab', () => complete(), { description: __`complete`, priority: 4 });
  }
  keys.on('up', () => up(), { description: __`history`, priority: 2 });
  keys.on('down', () => down(), { description: __`history`, priority: 2 });
  keys.on('ctrl+r', () => reverse(), { description: __`search history`, priority: 1 });
  keys.on(
    'right',
    () => acceptGhost(),
    () =>
      ghostText() === undefined ? undefined : { description: __`accept suggestion`, priority: 3 }
  );
  keys.on('end', () => acceptGhost());
  keys.on(
    'escape',
    () => dismiss(),
    () => (popupOpen() ? { description: __`close`, priority: 3 } : undefined)
  );
  keys.on('ctrl+c', () => interrupt(), { description: __`clear`, priority: 2 });
  keys.on(
    'ctrl+d',
    () => eof(),
    () => (props.onExit === undefined ? undefined : { description: __`exit`, priority: 2 })
  );

  const helpRow = props.help
    ? box({ class: 'sigil-repl-keys' }, keyHelp(keys, { width: props.width }))
    : undefined;

  const host = box({
    ...props.props,
    // after the caller's, for TextField's reason: the pieces are placed against these
    'flex-direction': 'column',
    focusable: true,
    'min-width': 0,
    ...(props.width === undefined ? {} : { 'flex-shrink': 0, width: props.width }),
  });
  host.addClass('sigil-repl');
  host.append(
    heldBox,
    row,
    popup,
    noticeNode,
    footerSlot,
    ...(helpRow === undefined ? [] : [helpRow])
  );
  host.onFocusChange = (_, focused): void => {
    caret.toggleClass('sigil-focus', focused);
  };

  // --- the line, as text ---

  /** What is shown for the line: the history match while it is being searched. */
  function shownLine(): { at: number; text: string } {
    if (search !== undefined) {
      const match = search.at >= 0 ? (history.entries[search.at] ?? '') : '';
      const flat = match.replaceAll('\n', ' ');
      const at = flat.toLowerCase().indexOf(search.query.toLowerCase());
      return { at: at < 0 ? flat.length : at, text: flat };
    }
    return { at: cursor, text: value.get() };
  }

  /** The whole text, as the app sees it: held lines and the one being edited. */
  function whole(): string {
    return [...held, value.get()].join('\n');
  }

  /** Where the line being edited starts in `whole()`. */
  function base(): number {
    return held.reduce((sum, line) => sum + line.length + 1, 0);
  }

  /** A piece of the line as it is drawn: no control character. */
  const clean = (part: string): string => part.replaceAll(CONTROL, '');

  /** The best completion, as the text after the caret that Right would add. */
  function ghost(): { offer: Offer; text: string } | undefined {
    const line = value.get();
    if (
      !suggest ||
      search !== undefined ||
      dismissed ||
      offers.length === 0 ||
      cursor !== line.length ||
      range.to !== line.length
    ) {
      return undefined;
    }
    const typed = line.slice(range.from, range.to);
    const offer = offers[0] as Offer;
    return typed !== '' && offer.text.startsWith(typed) && offer.text !== typed
      ? { offer, text: offer.text.slice(typed.length) }
      : undefined;
  }

  // --- drawing ---

  /**
   * Draws the line, the popup and the notice.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  function draw(): boolean {
    const signature: unknown[] = [settled];

    // the lines held above
    signature.push(held);
    syncHeld(held);

    // the prompt: the search's, while there is one
    const label =
      search === undefined
        ? held.length > 0
          ? continuation
          : prompt
        : __`(search: ${search.query}) `;
    promptNode.setText(clean(label));
    signature.push(label);

    // the line and the caret, and the suggestion after it
    const shown = shownLine();
    const line = shown.text;
    const g = settled ? undefined : ghost();
    let offset = 0;
    if (settled) {
      before.setText(clean(line));
      caret.setText('');
      after.setText('');
      after.toggleClass('sigil-muted', false);
      caret.toggleClass('sigil-muted', false);
      field.scrollTo(0, 0);
    } else {
      const at = Math.min(shown.at, line.length);
      const head = clean(line.slice(0, at));
      let under: string;
      let tail: string;
      if (g !== undefined) {
        // the caret sits on the first character of the suggestion, which is how the
        // placeholder of a text field shows where the next one goes
        const end = boundary(g.text, 0, 1);
        under = g.text.slice(0, end);
        tail = g.text.slice(end);
      } else {
        const rest = clean(line.slice(at));
        const end = boundary(rest, 0, 1);
        under = rest.slice(0, end) || ' ';
        tail = rest.slice(end);
      }
      before.setText(head);
      caret.setText(under);
      after.setText(tail);
      caret.toggleClass('sigil-muted', g !== undefined);
      after.toggleClass('sigil-muted', g !== undefined);
      offset = stringWidth(head) - stringWidth(promptWindow(clean(line), at, room).before);
      field.scrollTo(offset, 0);
      signature.push(head, under, tail, offset);
    }

    // the popup
    const anchor = drawPopup(offset);
    signature.push(anchor);

    // the notice, which is `node`'s hint about the second Ctrl-C
    const noticed = settled ? undefined : notice;
    noticeNode.setText(noticed ?? '');
    noticeNode.setProps({ display: noticed === undefined ? 'none' : 'flex' });
    signature.push(noticed);

    footerSlot.setProps({ display: settled ? 'none' : 'flex' });
    helpRow?.setProps({ display: settled ? 'none' : 'flex' });

    const next = JSON.stringify(signature);
    const changed = next !== drawn;
    drawn = next;
    return changed;
  }

  /** Makes the held rows match the lines held. */
  function syncHeld(lines: readonly string[]): void {
    while (heldBox.children.length > lines.length) {
      heldBox.removeChild(heldBox.children.at(-1) as Element);
    }
    for (let i = 0; i < lines.length; i++) {
      const text = `${i === 0 ? prompt : continuation}${clean(lines[i] as string)}`;
      const existing = heldBox.children[i];
      if (existing === undefined) {
        heldBox.append(textNode(text, { class: 'sigil-repl-held-line', 'white-space': 'nowrap' }));
      } else if (existing.text !== text) {
        existing.setText(text);
      }
    }
  }

  /**
   * Draws the completions under the word they replace.
   *
   * @param offset - How many columns the line is scrolled off the left.
   * @returns What the popup is anchored at, for the signature.
   */
  function drawPopup(offset: number): string {
    if (settled || !popupOpen()) {
      popupRows = '';
      while (popup.children.length > 0) {
        popup.removeChild(popup.children[0] as Element);
      }
      popup.setProps({ display: 'none' });
      return '';
    }
    const rows = Math.max(1, maxItems);
    top = listWindow(offers.length, Math.max(0, active), rows, top);
    const visible = offers.slice(top, top + rows);
    const typed = value.get().slice(range.from, range.to);
    const widest = Math.max(
      ...visible.map(
        (offer) =>
          POINTER + stringWidth(offer.label) + (offer.hint ? 1 + stringWidth(offer.hint) : 0)
      )
    );
    const promptWidth = stringWidth(clean(held.length > 0 ? continuation : prompt));
    // the labels start at the word, as far as the line is scrolled, with the pointer
    // in the two columns before it; pulled back from the right edge where it would
    // not fit, and never left of column zero
    const wanted =
      promptWidth + stringWidth(clean(value.get().slice(0, range.from))) - offset - POINTER;
    const margin = Math.max(0, Math.min(wanted, columns - widest));
    popup.setProps({ display: 'flex', 'margin-left': margin });

    // the rows are rebuilt only when what they say has changed. A resize that moves
    // the margin is told to the layout by `onResize`, which is *during* a layout,
    // and elements built then are ones that layout never placed
    const said = `${top}|${active}|${typed}|${visible.map((offer) => `${offer.label}\u0000${offer.hint ?? ''}`).join('\u0001')}`;
    if (said !== popupRows) {
      popupRows = said;
      while (popup.children.length > 0) {
        popup.removeChild(popup.children[0] as Element);
      }
      for (const [i, offer] of visible.entries()) {
        popup.append(offerRow(offer, top + i === active, typed));
      }
    }
    return `${margin}|${said}`;
  }

  /** One row of the popup. */
  function offerRow(offer: Offer, isActive: boolean, typed: string): Element {
    const matched =
      offer.matched.length > 0 ? offer.matched : (fuzzyMatch(typed, offer.label)?.matched ?? []);
    return box(
      { class: isActive ? 'sigil-repl-item is-active sigil-accent' : 'sigil-repl-item' },
      textNode(isActive ? `${PROMPT_SYMBOLS.cursor} ` : '  ', {
        class: 'sigil-repl-pointer',
        'white-space': 'nowrap',
      }),
      box(
        { class: 'sigil-repl-label', 'flex-shrink': 0 },
        ...highlightRuns(clean(offer.label), matched).map((run) =>
          textNode(run.text, {
            class: run.on ? 'sigil-repl-match sigil-heading' : '',
            'white-space': 'nowrap',
          })
        )
      ),
      textNode(offer.hint ? clean(offer.hint) : '', {
        class: 'sigil-repl-hint sigil-muted',
        display: offer.hint ? 'flex' : 'none',
        'margin-left': 1,
        'white-space': 'nowrap',
      })
    );
  }

  // --- writing the line ---

  /** Puts the line and the caret where an edit said, and answers whether the line changed. */
  function put(edit: Edit): boolean {
    const changed = edit.value !== value.get();
    cursor = edit.cursor;
    cursorSignal.set(cursor);
    if (changed) {
      seen = edit.value;
      value.set(edit.value);
      props.onChange?.(edit.value);
    }
    return changed;
  }

  /** What an edit to the text asks of the rest: a new history position, and a new question. */
  function edited(): void {
    browsing = undefined;
    draft = undefined;
    dismissed = false;
    ask(false);
  }

  /** Replaces the whole buffer, held lines included, with an entry from the history. */
  function load(entry: string, at?: number): void {
    const parts = entry.split('\n');
    held = parts.slice(0, -1);
    heldSignal.set(held);
    put({ cursor: (parts.at(-1) as string).length, value: parts.at(-1) as string });
    if (at !== undefined) {
      cursor = Math.min(at, value.get().length);
      cursorSignal.set(cursor);
    }
    closeOffers();
  }

  /** Empties the buffer. */
  function clear(): void {
    held = [];
    heldSignal.set(held);
    put({ cursor: 0, value: '' });
    browsing = undefined;
    draft = undefined;
    closeOffers();
  }

  // --- completion ---

  /** Throws away what is offered and anything still being asked. */
  function closeOffers(): void {
    controller?.abort();
    controller = undefined;
    offers = [];
    active = -1;
    top = 0;
    forced = false;
  }

  /**
   * Asks the provider about the line as it is now.
   *
   * @param force - Whether Tab asked: a lone answer is then taken at once.
   */
  function ask(force: boolean): void {
    controller?.abort();
    controller = undefined;
    forced = force;
    if (props.completer === undefined || search !== undefined) {
      offers = [];
      return;
    }
    const own = new AbortController();
    controller = own;
    const text = whole();
    const at = base() + cursor;

    let answer: ReturnType<AutocompleteRangeSource>;
    try {
      answer = props.completer(text, at, own.signal);
    } catch (error) {
      offers = [];
      fail(error);
      return;
    }
    if (typeof (answer as PromiseLike<unknown> | undefined)?.then === 'function') {
      // what is on screen is an answer about an earlier line, and applying it would
      // put the wrong word where the caret is -- so it goes until this one lands
      offers = [];
      active = -1;
      (answer as Promise<unknown>).then(
        (result) => {
          // the signal rather than a comparison of lines: "superseded" and "happens
          // to be for the same text" are different, and only the first may not write
          if (!own.signal.aborted && !settled) {
            take(result, text);
            draw();
          }
        },
        (error: unknown) => {
          if (!own.signal.aborted && !settled) {
            fail(error);
          }
        }
      );
    } else {
      take(answer, text);
    }
  }

  /**
   * Takes an answer for the line it was asked about.
   *
   * @param answer - What the provider returned.
   * @param asked - The line it was asked about.
   */
  function take(answer: unknown, asked: string): void {
    const result = answer as
      | { from: number; items: readonly (Choice<string> | string)[]; to: number }
      | undefined;
    offers = [];
    active = -1;
    if (result === undefined || result === null) {
      return;
    }
    const { from, to } = result;
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to > asked.length
    ) {
      fail(
        new TypeError(`A REPL completion range is [${from}, ${to}] over a line of ${asked.length}`)
      );
      return;
    }
    const start = base();
    // a range that reaches into the lines above is one this cannot replace
    if (from < start) {
      return;
    }
    const replaced = asked.slice(from, to);
    const typed = asked.slice(from, base() + cursor);
    range = { from: from - start, to: to - start };
    for (const item of result.items ?? []) {
      const choice = promptChoice<string>(item);
      if (choice.disabled) {
        continue;
      }
      const text = String(promptValue(choice));
      if (text === replaced) {
        continue;
      }
      offers.push({
        hint: choice.hint,
        label: choice.label,
        matched: fuzzyMatch(typed, choice.label)?.matched ?? [],
        text,
      });
    }
    if (forced && offers.length === 1) {
      forced = false;
      accept(0);
    }
  }

  /** Reports a failure that is not the REPL's to raise. */
  function fail(error: unknown): void {
    if (props.onError !== undefined) {
      props.onError(error);
    } else {
      console.error(errorMessage(error));
    }
  }

  /** Puts completion `i` where the word was. */
  function accept(i: number): void {
    const offer = offers[i];
    if (offer === undefined) {
      return;
    }
    const line = value.get();
    const next = line.slice(0, range.from) + offer.text + line.slice(range.to);
    closeOffers();
    put({ cursor: range.from + offer.text.length, value: next });
    edited();
  }

  // --- the keys ---

  /** Enter. */
  function submit(): boolean {
    if (popupOpen() && active >= 0) {
      accept(active);
      return true;
    }
    const current = value.get();
    const line = [...held, current].join('\n');
    busy = true;
    const finish = async (): Promise<void> => {
      try {
        let more = false;
        if (props.isContinued !== undefined) {
          try {
            more = await props.isContinued(line);
          } catch {
            // a callback that throws is not a reason to be unable to run the line
            more = false;
          }
        }
        if (more) {
          held = [...held, current];
          heldSignal.set(held);
          put({ cursor: 0, value: '' });
          browsing = undefined;
          closeOffers();
          return;
        }
        closeOffers();
        history.add(line);
        const blank = line.trim() === '';
        if (blank && props.submitBlank !== true) {
          clear();
          return;
        }
        const result = props.onSubmit(line);
        // cleared before the app's work, so a slow command shows the next line
        // empty rather than the one it is running; a runner that settled the
        // component has nothing left to clear
        if (!settled) {
          clear();
        }
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
          try {
            await result;
          } catch (error) {
            fail(error);
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        busy = false;
        draw();
      }
    };
    void finish();
    return true;
  }

  /** Tab. */
  function complete(): boolean {
    if (popupOpen()) {
      accept(active >= 0 ? active : 0);
      return true;
    }
    dismissed = false;
    ask(true);
    return true;
  }

  /** Up. */
  function up(): boolean {
    if (popupOpen() && active >= 0) {
      active -= 1;
      return true;
    }
    return step(-1);
  }

  /** Down. */
  function down(): boolean {
    if (popupOpen()) {
      active = Math.min(offers.length - 1, active + 1);
      return true;
    }
    return step(1);
  }

  /** One step through the history. */
  function step(by: -1 | 1): boolean {
    // a line being written over several rows is not a place to walk the history
    // from: Up would throw away everything held, and nothing would say so
    if (held.length > 0 && browsing === undefined) {
      return true;
    }
    if (browsing === undefined) {
      // what another REPL has run since this prompt was drawn is read now, which is
      // the one moment it matters: the walk is about to start from the newest
      history.sync();
    }
    const entries = history.entries;
    if (entries.length === 0) {
      return true;
    }
    if (browsing === undefined) {
      if (by === 1) {
        return true;
      }
      draft = { held: held, value: value.get() };
      browsing = entries.length;
    }
    const next = browsing + by;
    if (next < 0) {
      return true;
    }
    if (next >= entries.length) {
      // past the newest is what was being typed
      const back = draft;
      browsing = undefined;
      draft = undefined;
      held = back?.held ?? [];
      heldSignal.set(held);
      put({ cursor: (back?.value ?? '').length, value: back?.value ?? '' });
      closeOffers();
      return true;
    }
    browsing = next;
    load(entries[next] as string);
    return true;
  }

  /** Right and End: take the suggestion, where there is one and the caret is past its end. */
  function acceptGhost(): boolean {
    const g = ghost();
    if (g === undefined) {
      return false;
    }
    accept(0);
    return true;
  }

  /** Escape. */
  function dismiss(): boolean {
    if (!popupOpen()) {
      return false;
    }
    dismissed = true;
    return true;
  }

  /** Ctrl-C. */
  function interrupt(): boolean {
    if (search !== undefined) {
      cancelSearch();
      return true;
    }
    if (hasLine()) {
      // `node`'s first Ctrl-C: the line goes, and nothing is armed
      clear();
      armed = false;
      notice = undefined;
      return true;
    }
    if (props.onExit === undefined) {
      return false;
    }
    if (armed) {
      props.onExit('interrupt');
      return true;
    }
    armed = true;
    notice = __`(To exit, press Ctrl+C again or Ctrl+D)`;
    return true;
  }

  /** Ctrl-D: end of input on an empty line, delete under the caret on any other. */
  function eof(): boolean {
    if (!hasLine()) {
      if (props.onExit === undefined) {
        return false;
      }
      props.onExit('eof');
      return true;
    }
    const line = value.get();
    if (put(deleteAfter(line, cursor))) {
      edited();
    }
    return true;
  }

  // --- reverse search ---

  /** Ctrl-R: starts a search, or finds the next older match for the one under way. */
  function reverse(): boolean {
    if (search === undefined) {
      history.sync();
      search = {
        at: history.entries.length,
        query: '',
        saved: { cursor, held, value: value.get() },
      };
      closeOffers();
      searchFrom(search.at - 1);
      return true;
    }
    if (search.query !== '') {
      searchFrom(search.at - 1);
    }
    return true;
  }

  /** Finds the newest entry at or before `from` holding the query. */
  function searchFrom(from: number): void {
    const s = search as Search;
    if (s.query === '') {
      s.at = history.entries.length;
      return;
    }
    const entries = history.entries;
    // smart case: a query with no capital finds either, as `less` and `rg` do
    const exact = s.query !== s.query.toLowerCase();
    const needle = exact ? s.query : s.query.toLowerCase();
    for (let i = Math.min(from, entries.length - 1); i >= 0; i--) {
      const entry = entries[i] as string;
      if ((exact ? entry : entry.toLowerCase()).includes(needle)) {
        s.at = i;
        return;
      }
    }
    s.at = -1;
  }

  /** Leaves the search with the match as the line. */
  function acceptSearch(): void {
    const s = search as Search;
    const { at } = shownLine();
    search = undefined;
    if (s.at >= 0) {
      browsing = s.at;
      draft = { held: [...s.saved.held], value: s.saved.value };
      load(history.entries[s.at] as string, at);
    }
  }

  /** Leaves the search with the line as it was. */
  function cancelSearch(): void {
    const s = search as Search;
    search = undefined;
    held = [...s.saved.held];
    heldSignal.set(held);
    put({ cursor: s.saved.cursor, value: s.saved.value });
  }

  /**
   * A key while a search is under way.
   *
   * @returns `'handled'` if it was the search's, `'accepted'` if it ended the search
   *   and the key goes on to be read as an ordinary one, or `'taken'` for a key
   *   that ended it and is spent.
   */
  function searchKey(k: Key): 'accepted' | 'handled' | 'taken' {
    const s = search as Search;
    if (k.ctrl && k.name === 'r') {
      reverse();
      return 'handled';
    }
    if (k.name === 'escape' || (k.ctrl && (k.name === 'g' || k.name === 'c'))) {
      cancelSearch();
      return 'taken';
    }
    if (k.name === 'enter') {
      // the match goes into the line to be looked at, and Enter does not also run
      // it: a search that ran what it found would run it unread
      acceptSearch();
      return 'taken';
    }
    if (k.name === 'backspace' && !k.ctrl && !k.meta) {
      s.query = s.query.slice(0, -1);
      searchFrom(history.entries.length - 1);
      return 'handled';
    }
    const typed = typedText(k);
    if (typed !== undefined) {
      s.query += typed;
      searchFrom(s.at < 0 ? history.entries.length - 1 : Math.max(s.at, 0));
      // a failing search keeps looking from the newest on the next character
      if (s.at < 0) {
        searchFrom(history.entries.length - 1);
      }
      return 'handled';
    }
    // any other key ends the search and is then read as if it had been pressed with
    // the match as the line -- an arrow or Ctrl-A is how one edits what was found
    acceptSearch();
    return 'accepted';
  }

  // --- dispatch ---

  /**
   * One key.
   *
   * @returns Whether it was the REPL's, which is whether it goes no further.
   */
  function key(k: Key, pasted: boolean): boolean {
    if (!(k.ctrl && k.name === 'c') && (armed || notice !== undefined)) {
      armed = false;
      notice = undefined;
    }

    if (search !== undefined) {
      const was = searchKey(k);
      if (was !== 'accepted') {
        return true;
      }
    }

    if (k.name === 'enter' && pasted) {
      // a pasted line break is content, never a submission
      if (put(insertAt(value.get(), cursor, ' '))) {
        edited();
      }
      return true;
    }

    const bound = keys.match(k);
    if (bound?.(k)) {
      return true;
    }

    const now = value.get();
    const before = cursor;
    const edit = editLine(k, { cursor, value: now });
    if (edit !== undefined) {
      if (put(edit)) {
        edited();
      } else if (cursor !== before) {
        // moved within the line: what was asked was about another place in it
        closeOffers();
        dismissed = false;
      }
      return true;
    }

    const typed = typedText(k);
    if (typed === undefined) {
      return false;
    }
    put(insertAt(now, cursor, typed));
    edited();
    return true;
  }

  host.onKey = (event: KeyEvent): void => {
    if (settled || busy) {
      return;
    }
    if (key(event.key, event.paste)) {
      event.stop();
    }
    draw();
  };

  host.onPaste = (event: PasteEvent): void => {
    if (settled || busy) {
      return;
    }
    if (search !== undefined) {
      acceptSearch();
    }
    const flat = pastedLine(event.text);
    if (flat !== '') {
      put(insertAt(value.get(), cursor, flat));
      edited();
    }
    draw();
    event.stop();
  };

  host.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    columns = size?.width ?? props.width ?? Number.POSITIVE_INFINITY;
    return draw();
  };

  field.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    room = size?.width ?? props.width ?? Number.POSITIVE_INFINITY;
    return draw();
  };

  // a write the app made: nothing says where in the new line the caret belongs, so
  // the end, which is where a typist would be
  createEffect(() => {
    const now = value.get();
    untrack(() => {
      if (now !== seen) {
        seen = now;
        cursor = now.length;
        cursorSignal.set(cursor);
        closeOffers();
      }
      draw();
    });
  });

  // the footer, in an effect so that what it reads is watched
  createEffect(() => {
    if (props.footer === undefined) {
      return;
    }
    const line = [...heldSignal.get(), value.get()].join('\n');
    const at =
      heldSignal.get().reduce((sum, held) => sum + held.length + 1, 0) + cursorSignal.get();
    const made = props.footer(line, at);
    untrack(() => {
      if (typeof made === 'string' || made === undefined) {
        const only = footerSlot.children[0];
        if (made === undefined || made === '') {
          while (footerSlot.children.length > 0) {
            footerSlot.removeChild(footerSlot.children[0] as Element);
          }
        } else if (
          footerSlot.children.length === 1 &&
          only?.text !== undefined &&
          only.type === 'text'
        ) {
          only.setText(made);
        } else {
          while (footerSlot.children.length > 0) {
            footerSlot.removeChild(footerSlot.children[0] as Element);
          }
          footerSlot.append(textNode(made, { class: 'sigil-repl-footer-text sigil-muted' }));
        }
      } else if (footerSlot.children[0] !== made || footerSlot.children.length !== 1) {
        while (footerSlot.children.length > 0) {
          footerSlot.removeChild(footerSlot.children[0] as Element);
        }
        footerSlot.append(made);
      }
    });
  });

  draw();

  return {
    element: host,
    history,
    line: value,
    settle(): void {
      if (settled) {
        return;
      }
      // what the scrollback keeps is the whole of what was typed, rows and all
      const text = whole();
      held = text.split('\n').slice(0, -1);
      heldSignal.set(held);
      seen = text.split('\n').at(-1) as string;
      value.set(seen);
      closeOffers();
      search = undefined;
      settled = true;
      host.setProp('focusable', false);
      draw();
    },
  };
}

/**
 * A REPL line as an element, for a layout.
 *
 * `onSubmit` is called with the line and the line is cleared: what happens next,
 * and where its output goes, is the app's. A full-screen app puts it in a column
 * under a scroll box of its own output and focuses it.
 *
 * @param props - What to complete, where to keep history, and what to do on Enter.
 * @returns The focusable host element.
 */
export function Repl(props: ReplProps): Element {
  return createRepl(props).element;
}

/**
 * A completion provider over a fixed list of words, ranked as the palette ranks.
 *
 * The word is the run of non-space characters the caret is in, and it is what
 * `rankBy()` is given. A string is a word; a `Choice` is a word with a hint.
 *
 * @param words - What may be completed to.
 * @returns A provider for {@link ReplProps.completer}.
 */
export function wordCompleter(
  words: readonly (Choice<string> | string)[]
): AutocompleteRangeSource {
  const choices = words.map((word) => promptChoice<string>(word));
  return (line, cursor) => {
    const from = line.slice(0, cursor).search(/\S*$/);
    const to = cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0);
    const typed = line.slice(from, cursor);
    return {
      from,
      items: rankBy(typed, choices, (choice) => choice.label).map(({ item }) => item),
      to,
    };
  };
}

// --- the facade ---

/** What a command is handed beside its line. */
export interface ReplContext {
  /** Ends the REPL once this command returns. */
  exit(): void;
  /** Aborted when the REPL is given up with its `signal`. */
  readonly signal: AbortSignal | undefined;
}

export interface ReplOptions
  extends
    Omit<MountOptions, 'quiet'>,
    AccessibleOptions,
    Omit<ReplProps, 'onExit' | 'onSubmit' | 'props' | 'submitBlank' | 'value' | 'width'> {
  /**
   * The file lines are kept in, shared with every REPL that names it. See
   * `replHistoryFile()` for where an app's belongs. Without one, history lasts as
   * long as this call.
   */
  historyFile?: string;
  /** How many lines of history are kept. Defaults to 1,000. */
  historySize?: number;
  /**
   * Runs a line. The next prompt is drawn when it returns, or resolves.
   *
   * A throw or a rejection is written to stderr as its message and the REPL goes
   * on -- a typo in a command is not the end of the session -- unless `onError`
   * says what to do with it.
   */
  onSubmit: (line: string, context: ReplContext) => unknown;
  /** Where keys come from. Defaults to the terminal's input. */
  stdin?: InputStream;
  /** Ends the REPL, rejecting with the signal's reason, when it aborts. */
  signal?: AbortSignal;
}

/**
 * Reads lines and runs them until the user ends the session.
 *
 * On a terminal each line is a {@link Repl} drawn in a live region at the bottom
 * of the scrollback, with `node`'s keys: Ctrl-C clears the line and a second one
 * on an empty line ends the session, as does Ctrl-D on an empty line. What is
 * logged while the line is up -- by `console` -- is written above it and the line
 * is redrawn; a bare `process.stdout.write()` is not the console and is not caught,
 * for the reason `runApp()` records. The submitted line stays in the scrollback as
 * typed, the region is given up, and `onSubmit` runs with the terminal free.
 *
 * **Where nobody is typing** -- input that is not a terminal, or output that is
 * not, or `accessible` -- it reads lines from stdin with no editing, popup or
 * footer, so `echo 'deploy prod' | mycli repl` runs `deploy prod` and ends. No
 * prompt is written to a stdin that is not a terminal, and no history kept.
 *
 * @param opts - How to read and what to run.
 * @returns Settled when the session ends.
 * @throws The signal's reason, if it aborts.
 */
export async function repl(opts: ReplOptions): Promise<void> {
  if (typeof opts.onSubmit !== 'function') {
    throw new TypeError('Expected a REPL onSubmit to be a function');
  }
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);
  const signal = opts.signal;
  signal?.throwIfAborted();

  let ending = false;
  const context: ReplContext = {
    exit(): void {
      ending = true;
    },
    signal,
  };
  const report = (error: unknown): void => {
    if (opts.onError !== undefined) {
      opts.onError(error);
    } else {
      terminal.writeErr(`${errorMessage(error)}\n`);
    }
  };

  /** Runs one line, and says whether the session carries on. */
  async function run(line: string): Promise<boolean> {
    try {
      await opts.onSubmit(line, context);
    } catch (error) {
      report(error);
    }
    signal?.throwIfAborted();
    return !ending;
  }

  if (!canReadKeys({ stdin, terminal }) || promptAsLines(opts)) {
    await lines(opts, terminal, stdin, run);
    return;
  }

  const history = createHistory({
    file: opts.historyFile,
    max: opts.historySize,
    onError: report,
  });

  for (;;) {
    history.sync();
    const read = await readLine(opts, terminal, stdin as InputStream, history);
    if (read.exit !== undefined) {
      return;
    }
    if (read.line.trim() === '') {
      continue;
    }
    if (!(await run(read.line))) {
      return;
    }
  }
}

/** One line of an interactive session: what was typed, or why there is no more. */
async function readLine(
  opts: ReplOptions,
  terminal: NonNullable<ReplOptions['terminal']>,
  stdin: InputStream,
  history: History
): Promise<{ exit: ReplExit; line?: undefined } | { exit?: undefined; line: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let mounted: Mounted | undefined;
    let router: ReturnType<typeof createInput> | undefined;
    let console_: ReturnType<typeof captureConsole> | undefined;
    let controller: ReplController | undefined;
    let leave: (() => void) | undefined;

    /** Gives back everything this line took, in the order it was taken. */
    function giveBack(erase: boolean): void {
      leave?.();
      console_?.restore();
      router?.stop();
      if (erase) {
        mounted?.stop();
      } else {
        mounted?.done();
      }
    }

    function finish(value: { exit: ReplExit } | { line: string }): void {
      if (done) {
        return;
      }
      done = true;
      if ('line' in value) {
        controller?.settle();
        mounted?.frame();
      }
      try {
        giveBack('exit' in value);
      } catch (error) {
        reject(error);
        return;
      }
      resolve(value as never);
    }

    function fail(error: unknown): void {
      if (done) {
        return;
      }
      done = true;
      try {
        giveBack(true);
      } finally {
        reject(error);
      }
    }

    try {
      mounted = mountLive(
        () => {
          controller = createRepl({
            ...opts,
            history,
            onExit: (reason) => finish({ exit: reason }),
            onSubmit: (line) => finish({ line }),
            props: undefined,
            submitBlank: true,
            width: Math.max(1, terminal.width),
          });
          // a frame per key, as a prompt draws one: what a key did is on screen
          // before the next is read
          const { element } = controller;
          const onKey = element.onKey as (event: KeyEvent) => void;
          const onPaste = element.onPaste as (event: PasteEvent) => void;
          element.onKey = (event): void => {
            onKey(event);
            mounted?.frame();
          };
          element.onPaste = (event): void => {
            onPaste(event);
            mounted?.frame();
          };
          return controller.element;
        },
        { ...opts, onError: fail, quiet: false, terminal }
      );
    } catch (error) {
      reject(error);
      return;
    }
    if (done) {
      return;
    }

    try {
      router = createInput({
        hiddenBySheet: hiddenBySheet(mounted.cascade),
        root: mounted.renderer.root,
        stdin,
        terminal,
      });
      router.focus.focus((controller as ReplController).element);
    } catch (error) {
      fail(error);
      return;
    }

    const offEnd = router.onEnd((error) => {
      if (error === undefined) {
        finish({ exit: 'eof' });
      } else {
        fail(error);
      }
    });

    // the console while the line is up: a line logged by a timer lands above the
    // region and the region is drawn again under it
    const ring = createLogRing({
      onPush: (entry: LogEntry): void => {
        const to = entry.level === 'warn' || entry.level === 'error' ? 'stderr' : undefined;
        mounted?.backend.write(entry.text, to);
      },
    });
    console_ = captureConsole(ring);

    const { signal } = opts;
    let offAbort: (() => void) | undefined;
    if (signal !== undefined) {
      const onAbort = (): void => fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      offAbort = () => signal.removeEventListener('abort', onAbort);
    }
    leave = (): void => {
      offEnd();
      offAbort?.();
    };
  });
}

/**
 * The session as lines in: no editing, no popup, no footer.
 *
 * @param opts - What to run and how to continue a line.
 * @param terminal - Where a prompt is written, if anybody is there to read one.
 * @param stdin - Where lines come from.
 * @param run - Runs one line; says whether to go on.
 */
async function lines(
  opts: ReplOptions,
  terminal: NonNullable<ReplOptions['terminal']>,
  stdin: InputStream | undefined,
  run: (line: string) => Promise<boolean>
): Promise<void> {
  if (stdin === undefined) {
    return;
  }
  const { createInterface } = process.getBuiltinModule('node:readline');
  const input = createInterface({ crlfDelay: Infinity, input: stdin as never });
  const typing = Boolean(stdin.isTTY);
  const prompt = opts.prompt ?? '> ';
  const continuation = opts.continuation ?? '... ';
  const { signal } = opts;
  const onAbort = (): void => input.close();
  signal?.addEventListener('abort', onAbort, { once: true });

  let pending: string[] = [];
  try {
    if (typing) {
      terminal.write(prompt);
    }
    for await (const raw of input) {
      const line = [...pending, raw].join('\n');
      let more = false;
      if (opts.isContinued !== undefined) {
        try {
          more = await opts.isContinued(line);
        } catch {
          more = false;
        }
      }
      if (more) {
        pending = [...pending, raw];
        if (typing) {
          terminal.write(continuation);
        }
        continue;
      }
      pending = [];
      if (line.trim() !== '' && !(await run(line))) {
        return;
      }
      if (typing) {
        terminal.write(prompt);
      }
    }
    // the input ended with a line still open: it is what there is, so it runs
    if (pending.length > 0) {
      await run(pending.join('\n'));
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    input.close();
  }
  signal?.throwIfAborted();
}
