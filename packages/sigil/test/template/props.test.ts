import { box, HANDLER_PROPS } from '../../src/element/index.js';
import { COLOR_PROPERTIES, isProperty, PROPERTY_NAMES } from '../../src/style/index.js';
import { COLOR_PROP_NAMES } from '../../src/template/props.js';
import { describe, expect, it } from 'vitest';

describe('the host prop types', () => {
  it('should name the same colour properties the table does', () => {
    // the one list in `props.ts` that is written rather than derived, because
    // `Color` is `number` and a conditional type cannot tell a colour from a
    // padding. Written means it can drift, so this is what says it has not:
    // a fourth colour property would otherwise take `number | string` and
    // `color={39}` would type-check while `parseColor()` refuses it
    expect([...COLOR_PROP_NAMES].sort()).toEqual([...COLOR_PROPERTIES].sort());
  });

  it('should be routed to #apply() by setProp(), name by name, for every reserved prop', () => {
    // `ReservedProps` claims to be the names `Element` keeps out of the cascade.
    // The interface cannot be enumerated at run time, so the names are written
    // here and `jsx-types.tsx` asserts that `keyof ReservedProps` is this union:
    // the two together are what make the claim a test
    const values: Record<string, unknown> = {
      class: 'a',
      focusable: true,
      id: 'x',
      key: 'k',
      selectable: true,
      tabindex: 1,
    };
    for (const name of [...Object.keys(values), ...HANDLER_PROPS]) {
      const el = box();
      el.setProp(name, (values[name] ?? (() => {})) as never);
      expect(Object.keys(el.props), name).toEqual([]);
    }
  });

  it('should have no style property starting with "on", which a near-miss handler name relies on', () => {
    // `refuseHandlerName()` refuses `onClick=${fn}` and `on-key=${fn}` because no
    // property of the table could be meant by it. A property that starts with
    // `on` would be refused as an event, so the day one is added this fails first
    expect(PROPERTY_NAMES.filter((name) => /^on/i.test(name))).toEqual([]);
    for (const name of ['onClick', 'on-click', 'onKey', 'on-key', 'onkey']) {
      expect(isProperty(name), name).toBe(false);
    }
  });
});
