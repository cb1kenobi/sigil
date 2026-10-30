/**
 * A toggle prompt: a setting with two named states.
 *
 * `confirm()` asks a question and takes `y` or `n` for an answer. A setting is not
 * a question -- "notifications: on or off" has no "yes" in it -- so this one
 * names both states, shows both, and is answered by moving between them rather
 * than by typing a letter. Enquirer and prompts both have the same thing under
 * the same name.
 *
 * ```js
 * const enabled = await toggle({
 *   message: 'Notifications',
 *   active: 'enabled',
 *   inactive: 'disabled',
 *   initial: true,
 * });
 * // true
 * ```
 *
 * The inactive state is on the left and the active one on the right, like a
 * switch. Left and Right choose one, Tab and Space flip to the other, and Enter
 * answers.
 */

import { box, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';
import {
  PROMPT_SYMBOLS,
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  PromptError,
  type PromptOptions,
  runPrompt,
} from './prompt.js';

export interface ToggleOptions extends PromptOptions {
  /** What the `true` state is called. Defaults to `on`. */
  active?: string;
  /** What the `false` state is called. Defaults to `off`. */
  inactive?: string;
  /** The state the prompt starts in. Defaults to `false`, which is the left-hand one. */
  initial?: boolean;
}

/** Names an option that cannot be used, the way `selectKey()` does. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * Why a label cannot be drawn, or `undefined` if it can.
 *
 * Blank is refused because a text of nothing but spaces measures zero at
 * `white-space: normal`, so the state would have a marker and no name; a line
 * break because the two states are drawn on the one line.
 */
function fault(name: string, label: string): string | undefined {
  if (label.trim() === '') {
    return `\`${name}\` is empty, and a state with no name cannot be told from the other`;
  }
  if (/\p{Cc}/u.test(label)) {
    return `\`${name}\` ${JSON.stringify(label)} holds a control character`;
  }
  return undefined;
}

/**
 * Asks for one of two named states.
 *
 * @param opts - What to ask, and what the two states are called.
 * @returns `true` for the active state and `false` for the inactive one.
 */
export function toggle(opts: ToggleOptions): Promise<boolean> {
  const active = opts.active ?? __`on`;
  const inactive = opts.inactive ?? __`off`;

  const problem = fault('active', active) ?? fault('inactive', inactive);
  if (problem !== undefined) {
    return refuse(opts.message, problem);
  }
  // two states with one name are a choice the person cannot read, and the answer
  // would be a guess about which was meant
  if (active.trim() === inactive.trim()) {
    return refuse(
      opts.message,
      `\`active\` and \`inactive\` are both ${JSON.stringify(active.trim())}`
    );
  }

  // `value === state` is how the current one is found, so a truthy string would
  // leave neither marked and answer with the string
  if (opts.initial !== undefined && typeof opts.initial !== 'boolean') {
    return refuse(opts.message, `\`initial\` is ${JSON.stringify(opts.initial)}, not a boolean`);
  }

  const terminal = opts.terminal ?? defaultTerminal;
  let value = opts.initial ?? false;

  return runPrompt<boolean>(opts, () => {
    const left = textNode('', { 'flex-shrink': 0, 'margin-right': 2, 'white-space': 'nowrap' });
    const right = textNode('', { 'flex-shrink': 0, 'white-space': 'nowrap' });
    const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
    const options = [
      { label: inactive, node: left, state: false },
      { label: active, node: right, state: true },
    ];

    // the states are drawn whole or not beside the question at all. A prompt's
    // head caps what it reserves for a tail at half the line, which is right for a
    // hint that may wrap and wrong for this: the canvas clips what runs past its
    // edge, and a state clipped to `o` is a switch nobody can read. So when both do
    // not fit on the question's line they go under it
    const summary = `${PROMPT_SYMBOLS.on} ${inactive}  ${PROMPT_SYMBOLS.off} ${active}`;
    const width = Math.max(1, terminal.width);
    // the mark and the two margins around the message, and a column to spare
    const inline = stringWidth(opts.message) + stringWidth(summary) + 4 <= width;
    // what the line has to hold once answered is the longer name, and reserving it
    // is what keeps a question as wide as the screen from clipping its own answer
    const head = promptHeadWidths(
      opts.message,
      width,
      inline ? summary : stringWidth(active) > stringWidth(inactive) ? active : inactive
    );
    const choices = box({ class: 'sigil-toggle', 'margin-left': inline ? 0 : 2 }, left, right);
    const { line, mark } = promptHeadLine(
      opts.message,
      head.message,
      ...(inline ? [choices] : []),
      answer
    );
    const view = inline
      ? line
      : box({ class: 'sigil-prompt', 'flex-direction': 'column' }, line, choices);

    /** The marker is the only thing that says which is current at colour level 0. */
    function draw(): void {
      for (const { label, node, state } of options) {
        const here = state === value;
        node.setText(`${here ? PROMPT_SYMBOLS.on : PROMPT_SYMBOLS.off} ${label}`);
        node.setProps({
          class: here
            ? 'sigil-toggle-option is-active sigil-accent'
            : 'sigil-toggle-option sigil-muted',
        });
      }
    }

    draw();

    return {
      key(k) {
        if (k.name === 'enter') {
          return { value };
        }

        // a modifier makes it a different key, as it does for `confirm()`. Shift
        // is let through for Tab alone: Shift-Tab is how a form goes back, and
        // with two states back and forward are the same move
        if (k.ctrl || k.meta || (k.shift && k.name !== 'tab')) {
          return;
        }

        if (k.name === 'left') {
          value = false;
        } else if (k.name === 'right') {
          value = true;
        } else if (k.name === 'tab' || k.name === 'space') {
          value = !value;
        } else {
          return;
        }

        draw();
      },

      settle(final: boolean): void {
        promptAnswered(mark);
        answer.setText(final ? active : inactive);
        answer.setProps({ display: 'flex' });
        choices.setProps({ display: 'none' });
      },

      view,
    };
  });
}
