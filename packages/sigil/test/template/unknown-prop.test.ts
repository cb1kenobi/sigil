/**
 * A prop a `<box>` or a `<text>` does not take is refused when it is built (SIG-614).
 *
 * SIG-599 refused one on a `<raw>`, because `<raw Tracked>` built a plain `raw()`
 * and left the cascade to say so on the first frame. `<box padddding>` is the
 * same mistake with the same remedy: until now it built, and the app failed with
 * a `StyleError` once it was already running. Every case here is a template that
 * built before this change, and asks for the refusal from the tag and from JSX --
 * the compiled path is held to the same sentences in `REFUSALS`, in
 * `packages/cli/test/template-corpus.ts`.
 */

import { box, text } from '../../src/element/index.js';
import { ui } from '../../src/template/index.js';
import { jsx } from '../../src/template/runtime.js';
import { describe, expect, it } from 'vitest';

const TAKES =
  'It takes `ref`, and what any element takes: a style property, `class`, `id`, `key`, the focus props and the handlers';

/** What building it threw, or an empty string. */
function messageOf(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe.each([
  {
    jsxMisspelled: () => jsx('box', { padddding: 1 }),
    name: 'box',
    prop: 'padddding',
    tagMisspelled: () => ui`<box padddding="1" />`,
  },
  {
    jsxMisspelled: () => jsx('text', { children: 'hi', colour: 'red' }),
    name: 'text',
    prop: 'colour',
    tagMisspelled: () => ui`<text colour="red">hi</text>`,
  },
])('a prop a <$name> does not take', ({ jsxMisspelled, name, prop, tagMisspelled }) => {
  it('should be refused from the ui tag, naming the prop, the element and what it takes', () => {
    const message = messageOf(tagMisspelled);
    expect(message.startsWith(`<${name}> has no prop \`${prop}\`. ${TAKES}`)).toBe(true);
  });

  it('should be refused from JSX, with the same words', () => {
    const fromTag = messageOf(tagMisspelled).replace(/ \(at .*\)$/, '');
    expect(fromTag).not.toBe('');
    expect(messageOf(jsxMisspelled)).toBe(fromTag);
  });

  it('should say where the template was written', () => {
    expect(tagMisspelled).toThrow(/\(at line 1\)$/);
  });
});

describe('what a <box> and a <text> still take', () => {
  it('should take every style property in both spellings, the shorthands, and the aliases', () => {
    expect(
      () => ui`<box padding="1" padding-left="2" paddingLeft="2" flex-flow="column" />`
    ).not.toThrow();
    expect(() => ui`<text color="red" background-color="blue" bold>x</text>`).not.toThrow();
    expect(() =>
      jsx('box', { backgroundColor: 'red', flexFlow: 'column', width: 3 })
    ).not.toThrow();
  });

  it('should take the reserved props, the seven handlers and a ref', () => {
    const noop = () => {};
    expect(
      () => ui`<box class="a b" id="x" key="k" tabindex="0" focusable selectable
        onKey=${noop} onMouse=${noop} onPaste=${noop} onFocusChange=${noop} onScroll=${noop}
        onResize=${noop} onLayout=${noop} ref=${noop} />`
    ).not.toThrow();
    expect(() =>
      jsx('text', { children: 'x', class: 'a', id: 'x', onKey: noop, ref: noop, selectable: true })
    ).not.toThrow();
  });

  it('should take a reactive prop, whose name is the same question', () => {
    expect(() => ui`<box width=${() => 3} />`).not.toThrow();
  });

  it('should leave a component its own props, which are not the cascade’s', () => {
    const Card = (props: { title?: string }) => box({}, text(props.title ?? ''));
    expect(() => ui`<${Card} title="x" notAStyle="y" />`).not.toThrow();
  });
});

describe('the sentence for a refused prop', () => {
  it('should not refuse a name nothing reads when it was given nothing, as an omitted attribute is', () => {
    expect(() => jsx('box', { foo: undefined })).not.toThrow();
    expect(() => jsx('text', { children: 'x', foo: undefined })).not.toThrow();
  });

  it('should escape a control character in the name it echoes', () => {
    expect(() => jsx('box', { 'a\u001b[31mb': 1 })).toThrow(/no prop `a\\x1B\[31mb`/);
    expect(() => jsx('text', { 'a\u001b[31mb': 1, children: 'x' })).toThrow(
      /no prop `a\\x1B\[31mb`/
    );
  });

  it('should refuse a name no style property has, which the prop store used to swallow', () => {
    // `Object.prototype`'s `__proto__` setter took it, so it built and did nothing
    expect(() => ui`<text __proto__="x">y</text>`).toThrow(/<text> has no prop `__proto__`/);
    expect(() => jsx('box', { constructor: 1 })).toThrow(/<box> has no prop `constructor`/);
  });

  it('should keep a near miss for a handler its own sentence, and say what an unknown event is', () => {
    expect(() => ui`<box onkey=${() => {}} />`).toThrow(/not a handler name: write `onKey`/);
    expect(() => ui`<box onClick=${() => {}} />`).toThrow(/is not an event this element has/);
    // given a string, which no build could have called, and which reached the
    // cascade as an unknown property on the first frame
    expect(() => ui`<text on-click="go">x</text>`).toThrow(
      /`on-click` is not an event this element has/
    );
    // a name that only begins with the letters is not an event
    expect(() => ui`<box only="x" />`).toThrow(/<box> has no prop `only`/);
  });

  it('should refuse the first prop that nothing reads, in the order they were written', () => {
    expect(() => ui`<box width="3" padddding="1" heigth="2" />`).toThrow(/no prop `padddding`/);
  });
});
