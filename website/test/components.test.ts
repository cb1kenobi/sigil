import { componentCapture, describeComponent, takesSignal } from '../src/lib/component-data.ts';
import { COMPONENTS, FAMILIES, HELPERS, componentsOf } from '../src/lib/components.ts';
import * as barrel from '@ttylabs/sigil/components';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The components list against the code it lists.
 *
 * `src/lib/components.ts` says what counts: a component is an export somebody
 * calls to ask or draw something, and its other forms go on its page; anything
 * else is a helper, under the reason it is not a component. These hold the list
 * to `@ttylabs/sigil/components` as it is built, so that a component cannot be
 * exported without a page and a helper cannot be exported without somebody
 * deciding it is one.
 */

const EXAMPLES = join(import.meta.dirname, '../src/content/components');

/** Every value the barrel exports, as an app sees it at run time. */
const exported = Object.keys(barrel).sort();

/** Where each name is listed: an entry's slug, or a helper reason. */
function listings(): Map<string, string[]> {
  const where = new Map<string, string[]>();
  const add = (name: string, place: string) => where.set(name, [...(where.get(name) ?? []), place]);

  for (const entry of COMPONENTS) {
    for (const name of entry.exports) {
      add(name, entry.slug);
    }
  }
  for (const [reason, names] of Object.entries(HELPERS)) {
    for (const name of names) {
      add(name, reason);
    }
  }
  return where;
}

describe('the components list', () => {
  it('should list every export of @ttylabs/sigil/components as a component or a helper', () => {
    const where = listings();
    const missing = exported.filter((name) => !where.has(name));

    assert.deepEqual(
      missing,
      [],
      'an export with no entry: give it one in COMPONENTS if it is a component, or put it in HELPERS under why it is not'
    );
  });

  it('should list each export once', () => {
    const twice = [...listings()].filter(([, places]) => places.length > 1);

    assert.deepEqual(twice, []);
  });

  it('should list nothing the barrel does not export', () => {
    const gone = [...listings().keys()].filter((name) => !exported.includes(name));

    assert.deepEqual(gone, []);
  });

  it('should give every component a unique slug, a family and an example to run', () => {
    const slugs = COMPONENTS.map((entry) => entry.slug);

    assert.equal(new Set(slugs).size, slugs.length);
    for (const entry of COMPONENTS) {
      assert.ok(
        FAMILIES.some((family) => family.id === entry.family),
        entry.slug
      );
      assert.ok(existsSync(join(EXAMPLES, `${entry.slug}.mjs`)), `${entry.slug}.mjs`);
      assert.match(entry.slug, /^[a-z][a-z-]*$/);
    }
  });

  it('should have a component in every family', () => {
    for (const family of FAMILIES) {
      assert.notEqual(componentsOf(family.id).length, 0, family.id);
    }
  });

  it('should take the description of a component that is a whole sigil add entry from that entry', () => {
    const shared = new Map<string, number>();
    for (const entry of COMPONENTS) {
      if (entry.registry) {
        shared.set(entry.registry, (shared.get(entry.registry) ?? 0) + 1);
      }
    }

    for (const entry of COMPONENTS) {
      const whole = entry.registry !== undefined && shared.get(entry.registry) === 1;
      // one that shares its file with others, or has none, says what it is itself
      assert.equal(entry.description === undefined, whole, entry.slug);
      // a sentence, or the registry's own form for a file of functions: `group() to run ...`
      assert.match(describeComponent(entry), /^(?:[A-Z`]|[a-z]\w*\(\) ).*[.!?]$/, entry.slug);
    }
  });

  it('should be true that every prompt takes an AbortSignal, as the index says', () => {
    const without = componentsOf('prompts')
      .filter((entry) => !takesSignal(entry.slug))
      .map((entry) => entry.slug);

    // group() asks other prompts, and each of those takes the signal itself
    assert.deepEqual(without, ['group']);
  });

  it('should have a capture for every component', () => {
    for (const entry of COMPONENTS) {
      assert.ok(componentCapture(entry.slug).views.rendered.output.length > 0, entry.slug);
    }
  });

  it('should only give accessible steps to a component that has a line form to take them', () => {
    for (const entry of COMPONENTS.filter((it) => it.example?.accessibleSteps)) {
      assert.ok(componentCapture(entry.slug).views.accessible, entry.slug);
    }
  });

  it('should have a file for every recipe and a page for every related component', () => {
    for (const entry of COMPONENTS) {
      for (const recipe of entry.recipes ?? []) {
        assert.ok(existsSync(join(EXAMPLES, `${recipe.file}.mjs`)), recipe.file);
      }
      for (const slug of entry.related ?? []) {
        assert.ok(
          COMPONENTS.some((it) => it.slug === slug && it.slug !== entry.slug),
          slug
        );
      }
    }
  });
});

describe('the select() page', () => {
  const captured = componentCapture('select');

  it("should show the real options, not the mockup's guess", () => {
    const names = captured.api.options.map((option) => option.name);

    for (const name of ['message', 'choices', 'initial', 'loop', 'value', 'signal', 'accessible']) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(captured.api.options.find((it) => it.name === 'initial')?.default, '0');
    assert.equal(captured.api.options.find((it) => it.name === 'choices')?.optional, false);
  });

  it('should have all three views, and keys found by pressing them', () => {
    assert.deepEqual(Object.keys(captured.views).toSorted(), ['accessible', 'narrow', 'rendered']);
    assert.deepEqual(captured.keys, [
      { effect: 'change', keys: ['up', 'down', 'home', 'end'] },
      { effect: 'answer', keys: ['enter'] },
      { effect: 'cancel', keys: ['ctrlC'] },
    ]);
  });

  it('should show a timeout falling back to a default in its recipe', () => {
    const output = captured.recipes?.timeout?.output ?? '';

    assert.match(output, /No answer, using us-east-1/);
    assert.match(output, /Deploying to us-east-1/);
  });
});
