import type { Row, Span } from './terminal-rows.ts';
import { ansiMatcher } from '@ttylabs/sigil/ansi';
import { createSgrState, isSgr } from '@ttylabs/sigil/wrap';

/**
 * A program's real output, escape sequences and all, as rows of styled spans.
 *
 * The parsing is sigil's, which is the point of doing it this way round: the
 * site draws what `@ttylabs/sigil` printed, and `@ttylabs/sigil` is what reads
 * it back. `ansiMatcher()` finds every sequence -- SGR, OSC, cursor movement,
 * the unterminated ones -- and `createSgrState()` is the tracker the wrapper
 * uses to know what is in effect at a line break: a reset clears it, `22` closes
 * bold without touching the colour, `38;2;;r;g;b` is one colour and not a colour
 * and a reset. So what a span is styled with is what a terminal would have had
 * in effect over that text, not a replay of every sequence seen so far.
 *
 * What is left here is naming the result: the tracker hands back the sequence
 * that would put the state back, `open()`, and that is read into the site's
 * tokens. Reading it rather than the raw input is what keeps this small -- the
 * state holds one entry per attribute and nothing that closes one, so there is
 * no reset, no close code and no ordering to get wrong a second time.
 *
 * A sequence that is not SGR draws nothing and is dropped: a hyperlink's text is
 * still drawn, as text, and a cursor movement has no meaning in a transcript.
 */

/** One colour, as a sequence named it. */
type Colour = { readonly index: number } | { readonly hex: string };

interface Attributes {
  background?: Colour;
  bold?: boolean;
  dim?: boolean;
  foreground?: Colour;
  hidden?: boolean;
  inverse?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
}

/**
 * The sixteen colours, by index, as text.
 *
 * The site has five terminal colours and the sixteen are folded onto them:
 * normal and bright are one token each, cyan and magenta are both the accent --
 * cyan because it is sigil's own default accent, the colour of a prompt's `?`
 * and a spinner, and magenta because it is what a theme reaches for to say
 * "accent" in purple, which the site's accent is. Black and bright black are
 * `dim`, since black on a terminal this dark is not something a reader could
 * read, and white is the terminal's own text.
 *
 * Written out whole, never built with a template: Tailwind finds a utility by
 * reading the source for it, and `text-${name}` is not one it can find.
 */
const TEXT = [
  'text-dim',
  'text-term-red',
  'text-term-green',
  'text-term-yellow',
  'text-term-blue',
  'text-term-accent',
  'text-term-accent',
  'text-fg-term',
  'text-dim',
  'text-term-red',
  'text-term-green',
  'text-term-yellow',
  'text-term-blue',
  'text-term-accent',
  'text-term-accent',
  'text-fg-strong',
] as const;

/** The same sixteen as a background. */
const FILL = [
  'bg-terminal',
  'bg-term-red',
  'bg-term-green',
  'bg-term-yellow',
  'bg-term-blue',
  'bg-term-accent',
  'bg-term-accent',
  'bg-fg-term',
  'bg-surface-2',
  'bg-term-red',
  'bg-term-green',
  'bg-term-yellow',
  'bg-term-blue',
  'bg-term-accent',
  'bg-term-accent',
  'bg-fg-strong',
] as const;

/**
 * What an inverse span is drawn as, by the colour it inverts.
 *
 * Inverse is how sigil draws two things the design has its own look for. A
 * badge is a status colour reversed -- `ESC[7;32m PASS` -- and is the badge
 * tokens from SIG-255, bold white on a fill dark enough to carry it. A selected
 * choice is the accent reversed, or plain text reversed, and is `term-select`:
 * the terminal inverted, dark on light.
 */
const INVERSE: Partial<Record<(typeof TEXT)[number], string>> = {
  'text-term-green': 'bg-badge-pass text-brand-fg font-bold',
  'text-term-red': 'bg-badge-fail text-brand-fg font-bold',
  'text-term-yellow': 'bg-badge-beta text-brand-fg font-bold',
  'text-term-blue': 'bg-term-blue text-terminal',
};

/** What a reversed span with no badge of its own is drawn as. */
const SELECTED = 'bg-term-select text-term-select-fg';

/**
 * One of the 256 palette colours, as a hex value.
 *
 * The first sixteen are the named colours and go through the tokens; this is
 * only asked about the cube and the grey ramp, which have exact values by
 * definition and nothing in the design to stand for them.
 *
 * @param index - 16 to 255.
 * @returns The colour.
 */
function palette(index: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');

  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
  }

  const cube = index - 16;
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`;
}

/**
 * An extended colour's parameters, in either form.
 *
 * The semicolon form spreads the colour over the parameters after `38`, and a
 * truecolor one may carry ITU T.416's colour space as an empty parameter first
 * -- the state stores either exactly as it was written. The colon form carries
 * it inside one parameter. Both come back as the parts after the mode.
 *
 * @param parts - `['5', n]` or `['2', r, g, b]`, with an optional empty colour
 *   space before the channels.
 * @returns The colour, or nothing for a shape that is neither.
 */
function extended(parts: readonly string[]): Colour | undefined {
  const [mode, ...rest] = parts;

  if (mode === '5') {
    const index = Number.parseInt(rest[0] ?? '', 10);
    if (!(index >= 0 && index <= 255)) {
      return undefined;
    }
    return index < 16 ? { index } : { hex: palette(index) };
  }

  if (mode === '2') {
    const channels = rest.length === 4 ? rest.slice(1) : rest;
    const [r, g, b] = channels.map((c) => Math.min(255, Number.parseInt(c, 10) || 0));
    return { hex: `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}` };
  }

  return undefined;
}

/**
 * What `state.open()` says is in effect.
 *
 * @param open - The sequence, `ESC [ params m`, or `''` for nothing.
 * @returns The attributes.
 */
function attributes(open: string): Attributes {
  const out: Attributes = {};

  if (open === '') {
    return out;
  }

  const params = open.slice(2, -1).split(';');

  for (let at = 0; at < params.length; at++) {
    const param = params[at]!;
    const code = Number.parseInt(param, 10) || 0;

    if (code === 38 || code === 48 || code === 58) {
      let colour: Colour | undefined;

      if (param.includes(':')) {
        colour = extended(param.split(':').slice(1));
      } else {
        // the state stored the colour as one run of parameters: the mode, then
        // one index or three channels, with T.416's empty colour space first
        // when it was written that way
        const mode = params[at + 1];
        const length = mode === '5' ? 1 : mode === '2' ? (params[at + 2] === '' ? 4 : 3) : 0;
        colour = extended(params.slice(at + 1, at + 2 + length));
        at += 1 + length;
      }

      if (code === 38) {
        out.foreground = colour;
      } else if (code === 48) {
        out.background = colour;
      }
      continue;
    }

    if (code >= 30 && code <= 37) {
      out.foreground = { index: code - 30 };
    } else if (code >= 90 && code <= 97) {
      out.foreground = { index: code - 90 + 8 };
    } else if (code >= 40 && code <= 47) {
      out.background = { index: code - 40 };
    } else if (code >= 100 && code <= 107) {
      out.background = { index: code - 100 + 8 };
    } else if (code === 1) {
      out.bold = true;
    } else if (code === 2) {
      out.dim = true;
    } else if (code === 3) {
      out.italic = true;
    } else if (code === 4 || code === 21) {
      out.underline = true;
    } else if (code === 7) {
      out.inverse = true;
    } else if (code === 8) {
      out.hidden = true;
    } else if (code === 9) {
      out.strike = true;
    }
  }

  return out;
}

/**
 * The attributes, as what a span is drawn with.
 *
 * Bold with no colour of its own is `fg-strong`, which is how the design draws
 * a help heading; dim with none is `dim`, which is how it draws a hint. Dim over
 * a colour leaves the colour alone: the tokens are already the colours the
 * design wants on a terminal, and a dimmed one would be a colour it never chose
 * and `check-contrast.ts` never measured.
 *
 * @param attrs - What is in effect.
 * @returns The span's style.
 */
function style(attrs: Attributes): Omit<Span, 'text'> {
  const classes: string[] = [];
  let color: string | undefined;
  let background: string | undefined;

  const fg = attrs.foreground;
  const bg = attrs.background;
  const text = fg && 'index' in fg ? TEXT[fg.index] : undefined;

  if (attrs.inverse) {
    const look = text === undefined ? undefined : INVERSE[text];

    if (fg && 'hex' in fg) {
      background = fg.hex;
      classes.push('text-terminal');
    } else {
      classes.push(look ?? SELECTED);
    }
    if (attrs.bold && !look?.includes('font-bold')) {
      classes.push('font-bold');
    }
  } else {
    if (text) {
      classes.push(text);
    } else if (fg && 'hex' in fg) {
      color = fg.hex;
    } else if (attrs.bold) {
      classes.push('text-fg-strong');
    } else if (attrs.dim) {
      classes.push('text-dim');
    }

    if (bg && 'index' in bg) {
      classes.push(FILL[bg.index]!);
      // a light fill with no colour of its own would leave the terminal's light
      // text on it, so the text takes the terminal's background instead
      if (!fg && bg.index !== 0 && bg.index !== 8) {
        classes.push('text-terminal');
      }
    } else if (bg) {
      background = bg.hex;
    }

    if (attrs.bold) {
      classes.push('font-bold');
    }
  }

  if (attrs.italic) {
    classes.push('italic');
  }
  if (attrs.underline) {
    classes.push('underline');
  }
  if (attrs.strike) {
    classes.push('line-through');
  }
  if (attrs.hidden) {
    classes.push('invisible');
  }

  return {
    ...(classes.length > 0 ? { className: classes.join(' ') } : {}),
    ...(color ? { color } : {}),
    ...(background ? { background } : {}),
  };
}

/** Whether two spans can be drawn as one. */
function same(a: Span, b: Span): boolean {
  return a.className === b.className && a.color === b.color && a.background === b.background;
}

/**
 * A captured transcript, as rows.
 *
 * Style carries across a newline, the way it does in a terminal: a colour left
 * open at the end of a line is still in effect at the start of the next. Every
 * control character other than the newline and a tab is dropped, since none of
 * them is text and a `\r` would otherwise be drawn as nothing in the middle of a
 * row.
 *
 * @param text - What the program printed.
 * @returns The rows, one per line.
 */
export function sgrRows(text: string): Row[] {
  const state = createSgrState();
  const rows: Span[][] = [[]];

  const draw = (piece: string) => {
    const look = style(attributes(state.open()));
    // `\p{Cc}` names the set rather than spelling it, the way the build's own
    // escape pass does, with the newline and the tab handed back
    const lines = piece
      .replaceAll(/\p{Cc}/gu, (c) => (c === '\n' || c === '\t' ? c : ''))
      .split('\n');

    lines.forEach((line, at) => {
      if (at > 0) {
        rows.push([]);
      }
      if (line === '') {
        return;
      }
      const row = rows.at(-1)!;
      const span: Span = { ...look, text: line };
      const last = row.at(-1);
      if (last && same(last, span)) {
        row[row.length - 1] = { ...last, text: last.text + line };
      } else {
        row.push(span);
      }
    });
  };

  let at = 0;
  for (const match of text.matchAll(ansiMatcher())) {
    if (match.index > at) {
      draw(text.slice(at, match.index));
    }
    if (isSgr(match[0])) {
      state.apply(match[0]);
    }
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    draw(text.slice(at));
  }

  return rows.map((spans) => ({ spans }));
}
