import {
  declare,
  expandShorthand,
  gradientBox,
  gradientColors,
  longhandsFor,
  parseBoolean,
  parseColor,
  parseDeclaration,
  parseEasing,
  parseInteger,
  parseIterations,
  parseLength,
  parseMediaQueryList,
  parseSelector,
  parseSelectorList,
  parseStylesheet,
  parseTime,
  StyleError,
} from '../../src/style/index.js';
import { parseCount, parseFactor, parseKeyword } from '../../src/style/value.js';
import { describe, expect, it } from 'vitest';

// Built rather than typed, so no raw control character sits in this file: an
// ESC and a BEL that would retitle a terminal, and U+202E, which would draw the
// rest of a line backwards. `;`, braces, quotes and spaces are left out of it on
// purpose, because a stylesheet splits on every one of them and the point is to
// reach the message, not the tokenizer.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCodePoint(0x202e);
// U+2028 is whitespace to `trim()` and a line end to a terminal. Several messages
// echo the text a parser was given before it trimmed it, so this is how a
// character gets into one whose value had to be a number: it sits where the
// number's own whitespace would.
const LS = String.fromCodePoint(0x2028);
const LS_SHOWN = String.raw`\u{2028}`;
const HOSTILE = `${ESC}pwned${BEL}${RLO}`;
const SHOWN = String.raw`\x1Bpwned\x07\u{202E}`;

// what no message may hold: the class `escapeControls()` names, written here by
// the properties it is built from
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;

// the same value written as an identifier, each character behind a backslash
const NAME = [...HOSTILE].map((c) => `\\${c}`).join('');

interface Refusal {
  /** The fixed words of the message, so a case proves it reached the throw it names. */
  readonly says: string;
  readonly run: () => unknown;
  /** What the escaped value reads as in the message, if it is not `SHOWN`. */
  readonly shown?: string;
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error('expected a refusal, and there was none');
}

function expectEscaped(refusal: Refusal): void {
  const message = messageOf(refusal.run);
  expect(message).toContain(refusal.says);
  expect(message).not.toMatch(UNSAFE);
  // the value is still there, and legible, in its escaped spelling
  expect(message).toContain(refusal.shown ?? SHOWN);
}

/** A refusal whose only hostile character is a U+2028 where whitespace may sit. */
function padded(says: string, run: () => unknown): Refusal {
  return { says, run, shown: LS_SHOWN };
}

function sheet(source: string): () => unknown {
  return () => parseStylesheet(source);
}

function each(cases: Record<string, Refusal>): void {
  for (const [name, refusal] of Object.entries(cases)) {
    it(`should escape what ${name} echoes`, () => {
      expectEscaped(refusal);
    });
  }
}

describe('a stylesheet refusal', () => {
  each({
    'an unknown layer': { says: 'unknown layer', run: sheet(`@layer ${HOSTILE} { }`) },
    'a keyframes name': {
      says: 'invalid @keyframes name',
      run: sheet(`@keyframes ${HOSTILE} { }`),
    },
    'a declaration with no colon': {
      says: 'expected "property: value" in',
      run: sheet(`.a { ${HOSTILE} }`),
    },
    'a keyframe declaration with no colon': {
      says: 'expected "property: value" in',
      run: sheet(`@keyframes k { 0% { ${HOSTILE} } }`),
    },
    'a declaration with no value': { says: 'no value for', run: sheet(`.a { ${HOSTILE}: }`) },
    'a keyframe declaration with no value': {
      says: 'no value for',
      run: sheet(`@keyframes k { 0% { ${HOSTILE}: } }`),
    },
    'a keyframe selector': {
      says: 'invalid keyframe selector',
      run: sheet(`@keyframes k { ${HOSTILE} { color: red } }`),
    },
    'a property name': { says: 'Unknown property', run: sheet(`.a { ${HOSTILE}: red }`) },
    'a value the property refuses': {
      says: 'Invalid colour',
      run: sheet(`.a { color: ${HOSTILE} }`),
    },
    'a media query': { says: 'Invalid media query', run: sheet(`@media ${HOSTILE} { }`) },
    'a selector': { says: 'Invalid selector', run: sheet(`.a${HOSTILE} { color: red }`) },
  });

  it('should keep the line prefix in front of the escaped text', () => {
    const message = messageOf(sheet(`\n\n.a { color: ${HOSTILE} }`));
    expect(message).toMatch(/^Invalid stylesheet \(line 3\): Invalid colour "/);
    expect(message).toContain(SHOWN);
  });

  it('should carry a value parser refusal through the line wrap unchanged', () => {
    // `#guard()` hands a value parser's message to `#fail()`, which wraps it and
    // escapes nothing: the parser already did, at the throw
    const message = messageOf(sheet(`.a { padding: ${HOSTILE} }`));
    expect(message).toMatch(/^Invalid stylesheet \(line 1\): Invalid /);
    expect(message.split(SHOWN)).toHaveLength(2);
    expect(message).not.toMatch(UNSAFE);
  });
});

describe('a media query refusal', () => {
  each({
    'a query that asks nothing': padded('it asks nothing', () => parseMediaQueryList(`,${LS},`)),
    'a feature that is not one, in a longer query': {
      says: 'Unknown media feature',
      run: () => parseMediaQueryList(`(bogus) and (${HOSTILE})`),
    },
    'a prefixed feature with no value': {
      says: 'needs a value',
      run: () => parseMediaQueryList(`(min-width) ${HOSTILE}`),
    },
    'a keyword feature with no value': {
      says: 'it is always set',
      run: () => parseMediaQueryList(`(prefers-color-scheme) ${HOSTILE}`),
    },
    'a keyword feature with a range prefix': {
      says: 'takes no range',
      run: () => parseMediaQueryList(`(min-prefers-color-scheme: dark) ${HOSTILE}`),
    },
    'text where a feature test belongs': {
      says: 'expected a parenthesised feature test',
      run: () => parseMediaQueryList(HOSTILE),
    },
    'an unclosed feature test': {
      says: 'unclosed feature test',
      run: () => parseMediaQueryList(`(min-width: ${HOSTILE}`),
    },
    'a missing "and"': {
      says: 'expected "and"',
      run: () => parseMediaQueryList(`(min-width: 1) ${HOSTILE}`),
    },
    'a feature test that is no test': {
      says: 'Invalid media feature',
      run: () => parseMediaQueryList(`(${HOSTILE})`),
    },
    'a value a numeric feature refuses': {
      says: 'for media feature',
      run: () => parseMediaQueryList(`(min-width: ${HOSTILE})`),
    },
    'a value a keyword feature refuses': {
      says: 'for media feature',
      run: () => parseMediaQueryList(`(prefers-color-scheme: ${HOSTILE})`),
    },
  });
});

describe('a value refusal', () => {
  each({
    'a colour': { says: 'Invalid colour', run: () => parseColor(HOSTILE) },
    'a length': { says: 'Invalid length', run: () => parseLength(HOSTILE) },
    'a percentage': { says: 'Invalid percentage', run: () => parseLength(`${HOSTILE}%`) },
    'a boolean': { says: 'Invalid italic', run: () => parseBoolean(HOSTILE, 'italic') },
    'a time': { says: 'expected a time', run: () => parseTime(HOSTILE, 'transition-duration') },
    'an iteration count': {
      says: 'expected a number of 0 or more, or infinite',
      run: () => parseIterations(HOSTILE, 'animation-iteration-count'),
    },
    'a property name passed as the name': {
      says: 'expected true or false',
      run: () => parseBoolean('maybe', HOSTILE),
    },
    'a property name passed to a count': {
      says: 'expected a whole number of 0 or more',
      run: () => parseCount('x', HOSTILE),
    },
    'a property name passed to a factor': {
      says: 'expected a number of 0 or more',
      run: () => parseFactor('x', HOSTILE),
    },
    'a property name passed to an integer': {
      says: 'expected a whole number',
      run: () => parseInteger('x', HOSTILE),
    },
    'a property name passed to a time': {
      says: 'expected a time',
      run: () => parseTime('x', HOSTILE),
    },
    'a property name passed to a negative time': {
      says: 'a duration cannot be negative',
      run: () => parseTime('-1', HOSTILE),
    },
    'a property name passed to an iteration count': {
      says: 'or infinite',
      run: () => parseIterations('x', HOSTILE),
    },
    'a property name passed to a keyword': {
      says: 'expected one of',
      run: () => parseKeyword('x', ['a', 'b'], HOSTILE),
    },
    'a timing function': { says: 'Invalid timing function', run: () => parseEasing(HOSTILE) },
    'a cubic-bezier': {
      says: 'Invalid cubic-bezier',
      run: () => parseEasing(`cubic-bezier(1, 2, 3, ${HOSTILE})`),
    },
    'a steps() count': {
      says: 'steps() count',
      run: () => parseEasing(`steps(${HOSTILE})`),
    },
    'a property': { says: 'Unknown property', run: () => longhandsFor(HOSTILE) },
    'a declaration': { says: 'Unknown property', run: () => parseDeclaration(HOSTILE, 'red') },
    'a declare() call': { says: 'Unknown property', run: () => declare({ [HOSTILE]: 'red' }) },
    'a font-weight': {
      says: 'Invalid font-weight',
      run: () => parseDeclaration('font-weight', HOSTILE),
    },
    'a font-style': {
      says: 'Invalid font-style',
      run: () => parseDeclaration('font-style', HOSTILE),
    },
    'a text-decoration': {
      says: 'Invalid text-decoration',
      run: () => parseDeclaration('text-decoration', HOSTILE),
    },
    'a transition-property': {
      says: 'no such property',
      run: () => parseDeclaration('transition-property', HOSTILE),
    },
    'an empty transition-property entry': {
      says: 'an empty name in the list',
      run: () => parseDeclaration('transition-property', `color,,${HOSTILE}`),
    },
    'an animation-name': {
      says: 'Invalid animation-name',
      run: () => parseDeclaration('animation-name', HOSTILE),
    },
  });

  each({
    'a percentage with a space inside it': padded('Invalid percentage', () =>
      parseLength(`50 ${LS}%`)
    ),
    'a length that is not a whole number': padded('not a whole number of cells', () =>
      parseLength(`1.5${LS}`)
    ),
    'a factor that is negative': padded('expected a number of 0 or more', () =>
      parseDeclaration('flex-grow', `-1${LS}`)
    ),
    'an integer that is not whole': padded('expected a whole number', () =>
      parseInteger(`1.5${LS}`, 'z-index')
    ),
    'a duration that is negative': padded('a duration cannot be negative', () =>
      parseTime(`-1s${LS}`, 'transition-duration')
    ),
    'a keyword that is not allowed': {
      says: 'expected one of',
      run: () => parseDeclaration('flex-direction', HOSTILE),
    },
    'a cubic-bezier with an x past 1': padded('x coordinates', () =>
      parseEasing(`cubic-bezier(2, 0, 0, 0)${LS}`)
    ),
    'a cubic-bezier with a y past 1': padded('overshoot', () =>
      parseEasing(`cubic-bezier(0, 2, 0, 0)${LS}`)
    ),
  });

  it('should be a StyleError, so a caller catching one still catches it', () => {
    expect(() => parseColor(HOSTILE)).toThrow(StyleError);
  });
});

describe('a selector refusal', () => {
  each({
    'text no selector starts with': {
      says: 'Invalid selector',
      run: () => parseSelectorList(HOSTILE),
    },
    'text after a compound': {
      says: 'Invalid selector',
      run: () => parseSelectorList(`.a ${HOSTILE}`),
    },
    'an unknown pseudo-class': {
      says: 'Invalid selector',
      run: () => parseSelectorList(`.a:hover${HOSTILE}`),
    },
    'an :nth-child() argument': {
      says: 'Invalid :nth-child',
      run: () => parseSelectorList(`.a:nth-child(${HOSTILE})`),
    },
    'a :not() with nothing readable in it': {
      says: 'expected an element type',
      run: () => parseSelectorList(`.a:not(${HOSTILE})`),
    },
    'a combinator inside :not()': {
      says: 'combinators are not allowed',
      run: () => parseSelectorList(`.a:not(.b ${HOSTILE})`),
    },
  });
});

describe('a selector name written with backslash escapes', () => {
  // an identifier may hold any character a backslash escapes, and its name comes
  // back unescaped -- so these are the selector messages a hostile value reaches
  // through the name rather than through the text around it
  each({
    'an unknown pseudo-class': {
      says: 'Unknown pseudo-class',
      run: () => parseSelectorList(`.a:${NAME}`),
    },
    'a list given where one selector was asked for': {
      says: 'Expected one selector',
      // the backslash stays, since it is the source text's and not a control
      shown: String.raw`\\x1B`,
      run: () => parseSelector(`.a\\${ESC}, .b`),
    },
    'a :not() with an empty alternative': padded('empty', () =>
      parseSelectorList(`.a:not(.b,${LS})`)
    ),
  });
});

describe('a shorthand refusal', () => {
  each({
    'a name that is no shorthand': {
      says: 'is not a shorthand',
      run: () => expandShorthand(HOSTILE, 'red'),
    },
    'a flex that is no flex': { says: 'Invalid flex', run: () => expandShorthand('flex', HOSTILE) },
    'a flex-flow that is no flex-flow': {
      says: 'Invalid flex-flow',
      run: () => expandShorthand('flex-flow', HOSTILE),
    },
    'a transition with a third time': {
      says: 'no third time',
      run: () => expandShorthand('transition', `1s 2s 3s ${HOSTILE}`),
    },
    'a transition part that belongs nowhere': {
      says: 'is not part of it',
      run: () => expandShorthand('transition', HOSTILE),
    },
    'a transition holding a bare number': {
      says: 'needs a unit here',
      run: () => expandShorthand('transition', `1 ${HOSTILE}`),
    },
    'an animation with a third time': {
      says: 'no third time',
      run: () => expandShorthand('animation', `1s 2s 3s ${HOSTILE}`),
    },
    'an animation part that belongs nowhere': {
      says: 'is not part of it',
      run: () => expandShorthand('animation', HOSTILE),
    },
    'a transition holding a list': {
      says: 'one transition at a time',
      run: () => expandShorthand('transition', `${HOSTILE}, 1s`),
    },
  });
});

describe('a gradient refusal', () => {
  each({
    'a padding that is not a number': {
      says: 'Invalid padding',
      run: () =>
        gradientBox('x', ['#ff0000', '#0000ff'], { padding: HOSTILE as unknown as number }),
    },
    'a length that is not a number': {
      says: 'Invalid gradient length',
      run: () => gradientColors(['#ff0000', '#0000ff'], HOSTILE as unknown as number),
    },
    'a border it does not know': {
      says: 'Unknown border',
      run: () => gradientBox('x', ['#ff0000', '#0000ff'], { border: HOSTILE as 'round' }),
    },
  });
});
