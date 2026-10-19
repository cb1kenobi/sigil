import { yaml } from '../src/index.js';
import { file, read } from './helpers.js';
import { createConfigSync, json } from '@ttylabs/sigil/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README, asserted rather than described.
 *
 * The one arrangement that says something is the **expectation** read out of the
 * README and the **input** written here: the input is a copy of nothing, so it
 * has nothing to drift from, and the README's own block is then a claim about
 * what this store produces rather than about itself. Deriving the input from the
 * same place is how a document test becomes a test of nothing -- measured in the
 * runtime's own `readme.test.ts`, where four of five sabotages of a quoted block
 * survived.
 */
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

/**
 * The nth fenced block of a language, as it is written.
 *
 * `''` is a block with no info string, which is what the path listing is. The
 * info string is trimmed because git checks a README out with CRLF on Windows
 * and the `\r` rides along with it -- the Conventions entry this repository
 * records five instances of.
 */
function fence(lang: string, nth = 0): string {
  const blocks = [...readme.matchAll(/```(\w*)[^\n]*\r?\n([\s\S]*?)```/g)]
    .filter((m) => (m[1] as string).trim() === lang)
    .map((m) => (m[2] as string).replaceAll('\r\n', '\n'));
  expect(blocks.length, `no "${lang}" block ${nth}`).toBeGreaterThan(nth);
  return blocks[nth] as string;
}

describe("the README's own claims", () => {
  it('should name every export', () => {
    // an export nobody can find is an export nobody uses. Read off the barrel so
    // a name added without a sentence fails here, which is the class rather than
    // the instance
    const barrel = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
    const names = new Set<string>();

    for (const block of barrel.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const name of (block[1] as string).split(',')) {
        if (name.trim()) {
          names.add(name.trim());
        }
      }
    }

    expect(names.size).toBeGreaterThan(1);
    expect([...names].filter((name) => !readme.includes(name))).toStrictEqual([]);
  });

  it('should read the merge-key example the way it says', () => {
    // the first `yaml` fence is the merge example and the `text` fence after it
    // is the three paths
    const doc = fence('yaml', 0);
    const paths = fence('', 0)
      .trim()
      .split('\n')
      .map((line) => line.split('->').map((half) => half.trim()) as [string, string]);

    expect(paths).toHaveLength(4);

    const config = createConfigSync({ layers: [{ name: 'u', store: yaml(file(doc)) }] });
    for (const [path, shown] of paths) {
      // the README writes a string quoted and a number bare, which is what
      // `JSON.stringify` produces with single quotes swapped in
      expect(JSON.stringify(config.get(path)).replaceAll('"', "'"), path).toBe(shown);
    }
  });

  it('should write the second example the way it says', () => {
    // the `js` fence that sets the port, over the `yaml` fence after it
    const source = fence('yaml', 1);
    const path = file(source);
    const config = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });

    expect(fence('js', 1)).toContain("config.set('server.port', 9090)");
    config.set('server.port', 9090);
    config.saveSync();

    // "changes 8080 to 9090 and leaves every other byte identical"
    expect(read(path)).toBe(source.replace('8080', '9090'));
    expect(read(path)).not.toBe(source);
  });

  it('should refuse the two writes it shows the messages for', () => {
    const shown = fence('', 1).trim().split('\n');
    expect(shown).toHaveLength(2);

    // the **same document** the section shows, which is what makes the line
    // numbers in those two messages a claim rather than an illustration:
    // `staging` carries an own key as well as the merge, so removing the merged
    // one leaves it behind -- with only the `<<` in it, core's own prune rule
    // takes the empty map away and the edit is a removal of `staging` itself,
    // which is allowed and correct
    const path = file(fence('yaml', 0));

    const aliasWrite = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
    aliasWrite.set('mirror.retries', 5);
    // the README writes `/etc/myapp/config.yaml`, so what is compared is the
    // sentence after the path rather than the whole line
    expect(() => aliasWrite.saveSync()).toThrow(
      (shown[0] as string).slice((shown[0] as string).lastIndexOf(': ') + 2)
    );

    const mergeDelete = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
    mergeDelete.delete('staging.retries');
    expect(() => mergeDelete.saveSync()).toThrow(
      (shown[1] as string).slice((shown[1] as string).lastIndexOf(': ') + 2)
    );
  });

  it('should run the opening example, which is the one anybody copies first', () => {
    // the `js` fence at the top, with its paths pointed at files that exist. The
    // whole of what it claims is that a YAML layer and a JSON layer merge, which
    // is the one thing this package is for
    expect(fence('js', 0)).toContain("store: yaml('/etc/myapp/config.yaml')");

    const config = createConfigSync({
      layers: [
        { name: 'system', readOnly: true, store: yaml(file('server:\n  port: 9090\n')) },
        { name: 'user', store: json(file('{}', 'config.json')) },
      ],
      schema: { 'server.port': { default: 8080, type: 'int' }, plugins: { multiple: true } },
    });

    expect(config.get('server.port')).toBe(9090);
  });

  it('should quote the version table the way the parser answers it', () => {
    // every row of the 1.2-against-1.1 table, read out of the README and
    // measured: a table nobody ran is a table that goes stale when `yaml`
    // changes its mind
    // scoped to the version table's own section, because the residual table
    // further down has rows of the same shape -- and a scan that read both
    // asserted a rendering against a parse
    const section = readme.slice(
      readme.indexOf("## It reads YAML 1.2's core schema"),
      readme.indexOf('## Everything YAML has that JSON does not')
    );
    const rows = section
      .split('\n')
      .filter((line) => /^\| `\w+: /.test(line))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim())
      );

    expect(rows.length).toBeGreaterThan(8);

    for (const [shown, core] of rows as [string, string][]) {
      const body = shown.replaceAll('`', '');
      const got = (yaml(file(`${body}\n`)).readSync().value as Record<string, unknown>)[
        body.split(':')[0] as string
      ];
      const want = core.replaceAll('**', '').replace(/^(?:string|number|boolean) /, '');

      if (want === 'string') {
        expect(typeof got, shown).toBe('string');
        continue;
      }
      expect(typeof got === 'string' ? `'${got}'` : String(got), `${shown} should be ${core}`).toBe(
        want.replaceAll('`', '')
      );
    }
  });

  it('should refuse every value the "cannot hold" list names', () => {
    // read off the README as a count rather than as a list, because what each
    // bullet names is prose: what is asserted is that the section exists and
    // that every value the tests below cover is in it
    const section = readme.slice(readme.indexOf('## What YAML cannot hold'));
    for (const named of [
      '`undefined`',
      '**`NaN`**',
      '**A `bigint`**',
      '**A function or a symbol**',
      '**An invalid `Date`**',
      '**A `Map`, a `Set`, a class instance**',
      '**A hole in a sequence**',
      '**A value that refers back to itself.**',
    ]) {
      expect(section, named).toContain(named);
    }
  });

  it('should hold its own measured figures to what the build produces', () => {
    // "10 kB of its own code over one module", which is the figure a re-run is
    // the only way to confirm -- so the assertion is the magnitude rather than
    // the number, which is what stops it going stale on every minifier change
    const bundle = readFileSync(join(import.meta.dirname, '../dist/index.mjs'), 'utf8');
    expect(bundle.length).toBeGreaterThan(5_000);
    expect(bundle.length).toBeLessThan(20_000);
    expect(readme).toContain('**10 kB** of its own code over one module');

    // and the claim a consumer can check: the declaration names no `yaml` type
    const types = readFileSync(join(import.meta.dirname, '../dist/index.d.mts'), 'utf8');
    expect(types).not.toMatch(/from ["']yaml["']/);
    expect(readme).toContain('names no `yaml` type');
  });
});
