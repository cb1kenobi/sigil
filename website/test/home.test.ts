import {
  COMPONENT_CARDS,
  HOME_LEDE,
  HOME_SCREENS,
  homeRows,
  homeScreens,
  todoSource,
  WRITING_CARD,
} from '../src/lib/home.ts';
import { TAGLINE } from '../src/lib/site.ts';
import { strip } from '@ttylabs/sigil/ansi';
import * as components from '@ttylabs/sigil/components';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** What a screen printed, without its colour. */
function printed(id: string): string {
  return homeScreens()
    [id]!.runs.map((run) => strip(run.output))
    .join('\n');
}

describe('the home page', () => {
  it('should describe itself with the hero lede, which is not the tagline', () => {
    assert.ok(HOME_LEDE.startsWith('A command parser, interactive prompts'));
    assert.notEqual(HOME_LEDE, TAGLINE);
  });

  it('should have a captured screen for everything it draws', () => {
    for (const id of HOME_SCREENS) {
      assert.ok(homeRows(id).rows.length > 0, `${id} has rows`);
    }
    assert.deepEqual(Object.keys(homeScreens()).sort(), [...HOME_SCREENS].sort());
  });

  it('should draw real colour, not the glyph rules, in a screen that was captured with it', () => {
    const colour = (id: Parameters<typeof homeRows>[0]) =>
      homeRows(id).rows.some((row) => row.spans.some((span) => span.className));

    for (const id of ['hero', 'select', 'log', 'tasks', 'diff', 'rendered'] as const) {
      assert.ok(colour(id), `${id} has colour`);
    }
  });

  it('should show the todo source it captured the help, completion and prompt from', () => {
    assert.match(todoSource(), /alias: 'rm'/);
    assert.match(todoSource(), /'list, ls'/);
  });
});

describe('the parser section', () => {
  it('should say an alias in the name shows in help and completion, which the captures show', () => {
    assert.match(printed('parser'), /^ {2}list, ls {4}List the tasks$/m);
    assert.match(printed('completion'), /\blist {2}ls\b/);
  });

  it('should say an alias in the property stays out of both, which the captures show', () => {
    // `rm` is declared on `remove` and works, and neither listing names it
    assert.match(todoSource(), /alias: 'rm'/);
    assert.doesNotMatch(printed('parser'), /\brm\b/);
    assert.doesNotMatch(printed('completion'), /\brm\b/);
  });
});

describe('the components section', () => {
  it('should name six components, each made of exports of the components entry', () => {
    const exported = components as Record<string, unknown>;

    assert.equal(COMPONENT_CARDS.length, 6);
    for (const card of COMPONENT_CARDS) {
      for (const name of card.name.match(/[a-z]+/g) ?? []) {
        assert.ok(name in exported, `${name} is exported by ${card.name}`);
      }
    }
  });

  it('should link each card to a component page under /docs/components', () => {
    assert.deepEqual(
      COMPONENT_CARDS.map((card) => card.slug),
      ['select', 'table', 'log', 'tasks', 'markdown', 'diff']
    );
  });
});

describe('the agents section', () => {
  it('should link the writing card to the agent section of Getting started', () => {
    assert.equal(WRITING_CARD.href, '/docs/getting-started#agents');
    assert.equal(WRITING_CARD.link, 'Set up your agent');
    assert.match(WRITING_CARD.body, /also served as Markdown at the same address/);
    assert.match(WRITING_CARD.body, /paste into your project's AGENTS\.md/);
  });

  it('should show a prompt failing with no terminal and then succeeding with an argument', () => {
    const [failed, passed] = homeScreens().agent!.runs;

    assert.equal(failed!.command, 'todo add < /dev/null');
    assert.match(
      strip(failed!.output),
      /^Error: Cannot prompt for "Title" because the input is not a terminal$/
    );
    assert.equal(passed!.command, 'todo add "Renew passport"');
    assert.equal(strip(passed!.output), 'Added "Renew passport"');
  });
});

describe('accessible mode', () => {
  it('should draw the same prompt both ways: a repainted list and plain numbered lines', () => {
    assert.match(printed('rendered'), /^\? Components$/m);
    assert.match(printed('rendered'), /◉ Prompts/);
    assert.match(printed('accessible'), /^ {2}1\. Prompts$/m);
    assert.match(printed('accessible'), /^Chosen: Prompts, Spinners$/m);
  });
});
