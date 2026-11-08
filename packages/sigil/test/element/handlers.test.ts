import { box, Element, HANDLER_PROPS, isHandlerProp, text } from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The seven hooks as props, which is what lets `box({ onKey })` and a template's
 * `onKey=${fn}` be one path through `Element.#apply()`.
 */

/** A function of the right shape for each hook; the shapes differ, the test does not care. */
const noop = () => false;

describe('an element built with handler props', () => {
  it('should name the seven hooks, each a field of the class', () => {
    // the list the props and the template read, against the class it describes:
    // a name here that `Element` does not carry would be a prop that sets a field
    // nothing reads, and a hook the class gains is one this fails for
    expect([...HANDLER_PROPS]).toEqual([
      'onKey',
      'onMouse',
      'onPaste',
      'onFocusChange',
      'onScroll',
      'onResize',
      'onLayout',
    ]);
    const el = box();
    for (const name of HANDLER_PROPS) {
      expect(name in el, name).toBe(true);
      expect(isHandlerProp(name)).toBe(true);
    }
    expect(isHandlerProp('onClick')).toBe(false);
    expect(isHandlerProp('class')).toBe(false);
  });

  it('should set a hook from the constructor props, on every element type', () => {
    for (const name of HANDLER_PROPS) {
      expect(box({ [name]: noop })[name], name).toBe(noop);
      expect(text('x', { [name]: noop })[name], name).toBe(noop);
    }
  });

  it('should set a hook through setProp() and setProps()', () => {
    const el = box();
    el.setProp('onKey', noop);
    el.setProps({ onMouse: noop });
    expect(el.onKey).toBe(noop);
    expect(el.onMouse).toBe(noop);
  });

  it('should clear a hook given undefined, which is what a cleared prop is', () => {
    const el = box({ onKey: noop });
    el.setProp('onKey', undefined);
    expect(el.onKey).toBeUndefined();
  });

  it('should refuse a hook that is not a function, naming the prop', () => {
    expect(() => box({ onKey: 'x' as never })).toThrow(/Invalid onKey: expected a function/);
    expect(() => box().setProp('onResize', true as never)).toThrow(/Invalid onResize/);
  });

  it('should not hand a hook to the cascade as a style property', () => {
    // a hook that fell through to the property table would be refused there as
    // an unknown property, or stored and handed to every restyle
    const el = box({ onKey: noop, padding: '1' });
    expect(Object.keys(el.props)).toEqual(['padding']);
  });

  it('should keep a hook on the element it was set on', () => {
    const one = box({ onKey: noop });
    const other = new Element('box');
    expect(other.onKey).toBeUndefined();
    expect(one.onKey).toBe(noop);
  });
});
