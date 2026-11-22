import {
  declare,
  expandShorthand,
  gradientBox,
  longhandsFor,
  parseBoolean,
  parseColor,
  parseDeclaration,
  parseEasing,
  parseIterations,
  parseLength,
  parseMediaQueryList,
  parseSelectorList,
  parseStylesheet,
  parseTime,
  StyleError,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

// Built rather than typed, so no raw control character sits in this file: an
// ESC and a BEL that would retitle a terminal, and U+202E, which would draw the
// rest of a line backwards. `;`, braces, quotes and spaces are left out of it on
// purpose, because a stylesheet splits on every one of them and the point is to
// reach the message, not the tokenizer.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCodePoint(0x202e);
const HOSTILE = `${ESC}pwned${BEL}${RLO}`;
const SHOWN = String.raw`\x1Bpwned\x07\u{202E}`;

// what no message may hold: the class `escapeControls()` names, written here by
// the properties that cover everything it is built from
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

interface Refusal {
  /** The fixed words of the message, so a case proves it reached the throw it names. */
  readonly says: string;
  readonly run: () => unknown;
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
  expect(message).toContain(SHOWN);
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
    'a query that asks nothing': {
      says: 'Invalid media query',
      run: () => parseMediaQueryList(`,${HOSTILE},`),
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
      says: 'Invalid',
      run: () => parseBoolean('maybe', HOSTILE),
    },
    'a timing function': { says: 'Invalid timing function', run: () => parseEasing(HOSTILE) },
    'a cubic-bezier': {
      says: 'Invalid cubic-bezier',
      run: () => parseEasing(`cubic-bezier(1, 2, 3, ${HOSTILE})`),
    },
    'a steps() count': {
      says: 'Invalid',
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
      says: 'Invalid',
      run: () => parseSelectorList(`.a:not(${HOSTILE})`),
    },
    'a combinator inside :not()': {
      says: 'combinators are not allowed',
      run: () => parseSelectorList(`.a:not(.b ${HOSTILE})`),
    },
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
    'a border it does not know': {
      says: 'Unknown border',
      run: () => gradientBox('x', ['#ff0000', '#0000ff'], { border: HOSTILE as 'round' }),
    },
  });
});
