import { Checkbox } from '../../src/components/checkbox.js';
import { DataTable } from '../../src/components/data-table.js';
import { Dropdown } from '../../src/components/dropdown.js';
import { ListView } from '../../src/components/list-view.js';
import { RadioSet } from '../../src/components/radio-set.js';
import { Slider } from '../../src/components/slider.js';
import { Switch } from '../../src/components/switch.js';
import { Tabs } from '../../src/components/tabs.js';
import { TextArea } from '../../src/components/text-area.js';
import { TextField } from '../../src/components/text-field.js';
import { TreeListView } from '../../src/components/tree-list-view.js';
import { Treemap } from '../../src/components/treemap.js';
import { box } from '../../src/element/index.js';
import { createInput } from '../../src/input/index.js';
import { Computed, State } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What a control that writes its value takes, held by the compiler as well as the
 * runtime (SIG-515).
 *
 * Every control here refuses a `Computed` with a `TypeError` where it writes
 * its value, and a `// @ts-expect-error` over the same call is what a `tsc` run
 * answers to: the line fails to compile if the types go back to accepting one,
 * because an unused directive is itself an error. No `as never` stands between the
 * call and the type, which is what every runtime test of the refusal needs and what
 * hides the very thing asserted here. The calls beside them are the ordinary ones,
 * and they are in this file so that a type that stops inferring them fails here
 * too, rather than at an app.
 */

const routers: Array<ReturnType<typeof createInput>> = [];

afterEach(() => {
  routers.splice(0).forEach((router) => router.stop());
});

/** A router for the dropdown, which asks for one. */
function router() {
  const term = createTestTerminal({ columns: 40, rows: 10 });
  const input = createInput({ root: box({}), terminal: term.terminal });
  routers.push(input);
  return input;
}

describe('a Computed where a control writes its value', () => {
  const text = new State('a');
  const derived = new Computed(() => text.get());

  it('should not type-check as a radio set value', () => {
    expect(() =>
      RadioSet({
        options: ['a', 'b'],
        // @ts-expect-error -- the set writes it, and a Computed cannot be written
        value: derived,
      })
    ).toThrow('not a Computed');
    // a value, a State of one and a State of one or none are the ones that compile
    RadioSet({ options: ['a', 'b'], value: 'a' });
    RadioSet({ options: ['a', 'b'], value: new State('a') });
    RadioSet({ options: ['a', 'b'], value: new State<string | undefined>(undefined) });
  });

  it('should not type-check as a dropdown value', () => {
    expect(() =>
      Dropdown({
        input: router(),
        options: ['a', 'b'],
        // @ts-expect-error -- the dropdown writes it, and a Computed cannot be written
        value: derived,
      })
    ).toThrow('not a Computed');
    Dropdown({ input: router(), options: ['a', 'b'], value: 'a' });
    Dropdown({ input: router(), options: ['a', 'b'], value: new State<string | undefined>('a') });
  });

  it('should not type-check as a list current', () => {
    expect(() =>
      ListView({
        // @ts-expect-error -- the list writes it, and a Computed cannot be written
        current: derived,
        items: ['a', 'b'],
      })
    ).toThrow('not a Computed');
    ListView({ current: 'b', items: ['a', 'b'] });
    ListView({ current: new State<string | undefined>('b'), items: ['a', 'b'] });
    ListView({ current: 1, items: [{ id: 1 }, { id: 2 }], key: (item) => item.id });
  });

  it('should not type-check as a data table current', () => {
    expect(() =>
      DataTable({
        columns: ['a'],
        // @ts-expect-error -- the table writes it, and a Computed cannot be written
        current: derived,
        rows: [],
      })
    ).toThrow('not a Computed');
    DataTable({ columns: ['a'], current: 0, rows: [{ a: 1 }] });
  });

  it('should not type-check as a data table sort', () => {
    const sort = new Computed(() => ({ column: 'a' }));
    expect(() =>
      DataTable({
        columns: ['a'],
        rows: [],
        // @ts-expect-error -- the table writes it, and a Computed cannot be written
        sort,
      })
    ).toThrow('not a Computed');
    DataTable({ columns: ['a'], rows: [], sort: { column: 'a' } });
    DataTable({
      columns: ['a'],
      rows: [],
      sort: new State<{ column: string } | undefined>(undefined),
    });
  });

  it('should not type-check as a tree current', () => {
    expect(() =>
      TreeListView({
        // @ts-expect-error -- the tree writes it, and a Computed cannot be written
        current: derived,
        items: [{ text: 'a' }],
      })
    ).toThrow('not a Computed');
    TreeListView({ current: 'a', items: [{ text: 'a' }] });
  });

  it('should not type-check as a treemap current', () => {
    const node = { children: [] as never[], name: 'a', size: 1 };
    expect(() =>
      Treemap({
        children: () => undefined,
        // @ts-expect-error -- the treemap writes it, and a Computed cannot be written
        current: derived,
        key: () => 'a',
        label: () => 'a',
        root: node,
        size: () => 1,
      })
    ).toThrow('not a Computed');
  });

  it('should still type-check as a value when the options hold Computeds', () => {
    // the escape hatch the AGENTS.md entry names: a key that really is a signal is
    // named through a State, which is not a Computed
    RadioSet({
      options: [{ label: 'derived', value: derived }],
      value: new State<Computed<string> | undefined>(derived),
    });
  });

  // SIG-514's sweep: a function is the template's spelling of a live prop, and a
  // control whose value has a fixed type refuses one by refusing whatever is neither
  // that type nor a State. Only a value of the app's own type could take one for the
  // value, which is the radio set and the dropdown above.
  it.each([
    ['TextField', () => TextField({ value: (() => 'x') as never })],
    ['TextArea', () => TextArea({ value: (() => 'x') as never })],
    ['Slider', () => Slider({ max: 10, min: 0, value: (() => 1) as never })],
    ['Checkbox', () => Checkbox({ checked: (() => true) as never, label: 'a' })],
    ['Switch', () => Switch({ value: (() => true) as never })],
    ['Tabs', () => Tabs({ active: (() => 0) as never, tabs: [{ label: 'a' }] })],
  ])('should refuse a function value on %s rather than take it as the value', (_name, make) => {
    expect(make).toThrow(/ or a State$/);
  });
});
