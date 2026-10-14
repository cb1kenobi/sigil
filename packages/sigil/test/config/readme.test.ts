import { createConfig, createConfigSync, json, object } from '../../src/config/index.js';
import type { ConfigDocument, WritableConfigStore } from '../../src/config/index.js';
import { parse } from '../../src/parser/parse.js';
import { configHome } from '../../src/paths.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The README's own examples, run.
 *
 * Every other claim about this module is pinned by a test of its own; what this
 * one is for is the **documentation**, which is where a reader starts and which
 * nothing else checks. A sample whose comments say what it does not do is the
 * failure this file records three times over -- an example read at the wrong
 * moment, a recipe that is broken if followed, an option table that overclaims.
 */

/** The README, read once so the quoted lines can be asserted rather than trusted. */
// line endings normalized, because git checks a `.md` out with CRLF on Windows
// -- `.gitattributes` says `text=auto` and lists no `*.md` -- and the fence
// pattern below captures the info string with `.*`, which takes the `\r` with
// it: the language came back as `jsonc\r`, matched no filter, and four of these
// failed on three Windows CI jobs while saying "expected [] to have a length of
// 1". The subject here is the README's **text**, so reading it the way every
// platform stores it is the fixture's job rather than the pattern's. Found by
// review
const readme = readFileSync(join(import.meta.dirname, '../../README.md'), 'utf8').replaceAll(
  '\r\n',
  '\n'
);

/**
 * The one fenced block of a language inside the config section.
 *
 * Read out of the README rather than retyped, which is the stronger form of
 * what this file is for: a block quoted in a comment is a copy nothing
 * compares, and a copy nothing compares is one that drifts. Bounded to the
 * config section, because a `jsonc` fence elsewhere would make this answer
 * about a different page.
 *
 * @param lang - The fence's language, or `''` for an unmarked block.
 * @param holding - Text the block must contain, where the language alone names
 * more than one of them -- which the two unmarked blocks are.
 * @returns The block's contents.
 */
function fenced(lang: string, holding = ''): string {
  const from = readme.indexOf('## Config files');
  const to = readme.indexOf('## Subpath modules', from);
  const found = [...readme.slice(from, to).matchAll(/^```(.*)$\n([^]*?)^```$/gm)].filter(
    ([, it, body]) => it === lang && (body as string).includes(holding)
  );

  expect(found, `one \`\`\`${lang} block holding ${holding || '(anything)'}`).to.have.length(1);
  return (found[0] as RegExpExecArray)[2] as string;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sigil-readme-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("the README's own example", () => {
  it('should quote lines the README actually has', () => {
    // the structural half, and the reason it exists is that the instance it
    // closes happened: this file ran the example with `runtime` while its own
    // comment claimed the README said `runtime`, and the README said `user`
    // for another commit. A comment quoting a file is a copy of that file, and
    // a copy nothing compares is one that drifts -- which is the hazard this
    // repository records about prose generally, met inside the test written to
    // check prose
    for (const line of [
      "config.set('editor.theme', 'dark'); // into 'runtime', the topmost writable layer",
      "config.set('editor.theme', 'dark', 'runtime'); // or into a named one",
      "config.get('server.port'); // 8080, unless a layer or PORT said otherwise",
      "config.has('editor.theme'); // false where nothing configured it",
      "config.push('plugins', 'mine');",
      'await config.save(); // and `saveSync()` for an exit handler',
      'await config.save(); // every layer that changed',
      "await config.save('user'); // or one of them",
      'config.saveSync(); // which is what an exit handler needs',
      "config.set('server.port', 9090);",
      'await config.save({ lossy: true }); // this call',
      "layers: [{ name: 'generated', lossy: true, store: reprinting(path) }]; // this layer",
      "json('config.json'); // comments and trailing commas: fine",
      "config.set('server.retries', Infinity);",
    ]) {
      expect(readme, line).to.contain(line);
    }
  });

  it('should do what its comments say', async () => {
    writeFileSync(join(root, 'system.json'), JSON.stringify({ plugins: ['shipped'] }));

    const config = await createConfig({
      schema: {
        'server.port': { type: 'int', default: 8080, env: 'PORT' },
        'editor.theme': { type: 'string', choices: ['light', 'dark'] },
        plugins: { type: 'string', multiple: true, merge: 'concat' },
      },
      layers: [
        { name: 'system', readOnly: true, store: json(join(root, 'system.json')) },
        { name: 'user', store: json(join(root, 'config.jsonc')) },
        { name: 'runtime', store: object() },
      ],
      env: {},
    });

    // `config.get('server.port'); // 8080, unless a layer or PORT said otherwise`
    expect(config.get('server.port')).to.equal(8080);
    // `config.get('server'); // { port: 8080 } -- the merged subtree`
    expect(config.get('server')).to.deep.equal({ port: 8080 });
    // `config.has('editor.theme'); // false where nothing configured it`
    expect(config.has('editor.theme')).to.equal(false);
    // `config.set('editor.theme', 'dark'); // into 'runtime', the topmost writable layer`
    config.set('editor.theme', 'dark');
    expect(config.get('editor.theme')).to.equal('dark');
    // `config.set('editor.theme', 'dark', 'runtime'); // or into a named one`.
    // It named `user` until a review round read the README against this test,
    // and `user` was a file store that could not be written -- so the line
    // threw as published. Both file stores write now, so `user` is a layer a
    // named `set()` reaches; what still refuses is the layer declared
    // `readOnly`, which is the second of the two refusals and the one a `/etc`
    // file is for
    config.set('editor.theme', 'light', 'runtime');
    expect(config.get('editor.theme')).to.equal('light');
    expect(() => config.set('editor.theme', 'light', 'system')).toThrow(/read-only/);
    // `config.push('plugins', 'mine');`
    config.push('plugins', 'mine');
    expect(config.get('plugins')).to.deep.equal(['shipped', 'mine']);
    // `config.get('plugins')` reads as appending to the merged list, because
    // the schema said `concat`
    // `config.delete('editor.theme');`
    expect(config.delete('editor.theme')).to.equal(true);
    expect(config.has('editor.theme')).to.equal(false);
  });

  it('should write the file back the way the README says it does', async () => {
    // the README's own example of what a span write preserves, run. The
    // **expectation** is read out of the README and the input is written here,
    // which is the one arrangement that says anything: deriving the input from
    // the block by putting the port back makes both sides move together, so a
    // reflowed line, a trailing comma dropped or a comment moved onto its own
    // line each went unnoticed -- measured, three of four sabotages survived
    const after = fenced('jsonc');
    const path = join(root, 'config.jsonc');
    const before = [
      '// what this app is configured with',
      '{',
      '  "server": {',
      '    "port": 8080, // not 80, which needs root',
      '  },',
      '}',
      '',
    ].join('\n');
    writeFileSync(path, before);

    const config = await createConfig({
      schema: { 'server.port': { type: 'int' } },
      layers: [{ name: 'user', store: json(path) }],
      env: {},
    });

    // `config.set('server.port', 9090);`
    config.set('server.port', 9090);
    // `await config.save(); // every layer that changed`
    expect(await config.save()).to.deep.equal(['user']);

    // the block the README prints, byte for byte, which is the claim that
    // section is about: one token moved and nothing else in the file did
    expect(readFileSync(path, 'utf8')).to.equal(after);
    expect(after).to.not.equal(before);

    // `config.saveSync(); // which is what an exit handler needs`
    config.set('server.port', 1234);
    expect(config.saveSync()).to.deep.equal(['user']);
  });

  it('should claim only the paths the README shows it claiming', async () => {
    // the README prints the direct-store form of the three-way merge, so the
    // line it prints is the line that runs -- and what it is *for* is the half a
    // total write cannot do, which is why the assertion is about the key the
    // call never names
    const call = fenced('ts', 'store.write').trim();
    expect(call).to.equal("await store.write({ port: 9000 }, { paths: ['port'] });");

    const path = join(root, 'config.jsonc');
    writeFileSync(path, '{\n\t// kept\n\t"port": 8080,\n\t"host": "a"\n}\n');
    const store = json(path);

    await store.write({ port: 9000 }, { paths: ['port'] });

    expect(readFileSync(path, 'utf8')).to.equal(
      '{\n\t// kept\n\t"port": 9000,\n\t"host": "a"\n}\n'
    );

    // `Without it a write is total`, which is the sentence under the block
    await store.write({ port: 1 });
    expect(readFileSync(path, 'utf8')).to.equal('{\n\t// kept\n\t"port": 1\n}\n');
  });

  it('should refuse a lossy write in the words the README prints', () => {
    // the README shows the message in a fenced block, and a refusal whose
    // wording has moved is a recipe that is broken if followed -- so the two
    // lines of it are compared against what is thrown
    const printed = fenced('', 'Refusing to write').trim().split('\n');
    const store = {
      format: 'yamlish',
      read: () =>
        Promise.resolve({
          value: { a: 1 },
          wouldLose: [
            { kind: 'comment', line: 4 },
            { kind: 'comment', line: 11 },
            { detail: '&defaults', kind: 'anchor', line: 22 },
          ],
        }),
      readSync: () => ({
        value: { a: 1 },
        wouldLose: [
          { kind: 'comment', line: 4 },
          { kind: 'comment', line: 11 },
          { detail: '&defaults', kind: 'anchor', line: 22 },
        ],
      }),
      write: () => Promise.resolve(),
      writeSync: (): void => undefined,
    };
    const config = createConfigSync({ layers: [{ name: 'user', store }], env: {} });

    config.set('a', 2);
    let message = '';
    try {
      config.saveSync();
    } catch (e: unknown) {
      message = (e as Error).message;
    }

    expect(printed).to.have.length(2);
    expect(message.split('\n').map((it) => it.trim())).to.deep.equal(
      printed.map((it) => it.trim())
    );
  });

  it('should refuse what the README says it refuses', () => {
    // `config.set('server.retries', Infinity);`
    // `// user cannot hold the value at "server.retries": JSON has no Infinity`
    const config = createConfigSync({
      layers: [{ name: 'user', store: json(join(root, 'c.jsonc')) }],
      env: {},
    });

    expect(() => config.set('server.retries', Infinity)).toThrow(
      'user cannot hold the value at "server.retries": JSON has no Infinity'
    );
  });

  it('should take lossy per layer the way the README spells it', async () => {
    // `layers: [{ name: 'generated', lossy: true, store: reprinting(path) }]`
    //
    // over a store that really does report a loss, because the two in here never
    // do: with a `json()` layer the lossless check returns before it ever reads
    // `layer.lossy`, so this passed with the flag deleted -- which is the README's
    // own "the file stores in here never trip it" said against the test for it.
    // Found by review, and the example moved with it
    const store: WritableConfigStore = {
      format: 'yamlish',
      read: (): Promise<ConfigDocument> =>
        Promise.resolve({ value: { a: 1 }, wouldLose: [{ kind: 'comment', line: 4 }] }),
      readSync: (): ConfigDocument => ({ value: { a: 1 } }),
      source: '/etc/app/config.yaml',
      write: (): Promise<void> => Promise.resolve(),
      writeSync: (): void => undefined,
    };

    const config = await createConfig({
      layers: [{ lossy: true, name: 'generated', store }],
      env: {},
    });

    config.set('a', 2);
    expect(await config.save()).to.deep.equal(['generated']);

    // and without it the same save refuses, which is what says the flag is read
    const strict = await createConfig({ layers: [{ name: 'generated', store }], env: {} });
    strict.set('a', 2);
    await expect(strict.save()).rejects.toThrow(/comment:4 would be lost/);
  });

  it('should reach a file layer by name, which both file stores now are', async () => {
    // the half the walk above cannot assert without changing what the line
    // after it means: `delete()` with no name reaches the topmost writable
    // layer, so a value set into `user` as well would still be there
    const config = await createConfig({
      layers: [{ name: 'user', store: json(join(root, 'config.jsonc')) }],
      env: {},
    });

    config.set('editor.theme', 'dark', 'user');
    expect(config.get('editor.theme')).to.equal('dark');
    expect(config.layers[0]?.dirty).to.equal(true);
  });

  it('should mix an option with a setting the way the README says', async () => {
    // `options: { '--port [n]': { type: 'int', default: config.get('server.port') } }`
    //
    // through a real parse rather than a `get()`, because the claim is about the
    // *chain*: "argv -> env -> config through the chain that already exists". The
    // first version of this asserted that a defaulted setting reads back as a
    // number and built no option at all, so it could not fail if the mixing were
    // broken. Found by review
    const config = createConfigSync({
      schema: { 'server.port': { type: 'int', default: 8080 } },
      env: {},
    });

    const schema = {
      name: 'app',
      options: { '--port [n]': { env: 'PORT', type: 'int', default: config.get('server.port') } },
    } as const;

    // nothing said, so the config's value is what lands -- which is the whole of
    // what this spelling buys
    expect((await parse({ argv: [], env: {}, schema })).argv.port).to.equal(8080);
    // the environment beats it, and argv beats that, which is the chain the
    // README names and is the parser's own rather than anything config added
    expect((await parse({ argv: [], env: { PORT: '2' }, schema })).argv.port).to.equal(2);
    expect((await parse({ argv: ['--port', '1'], env: { PORT: '2' }, schema })).argv.port).to.equal(
      1
    );
  });

  it('should name every export in the README', () => {
    // an export nobody can find is an export nobody uses, and six of the types
    // were in neither the prose nor the catalog -- which a reader writing a
    // function that takes a `ConfigOptions` has no way past. Found by review, and
    // the class is closed rather than the instance: read off the **barrel** so a
    // name added without a sentence fails here
    const barrel = readFileSync(join(import.meta.dirname, '../../src/config/index.ts'), 'utf8');
    const names = new Set<string>();

    for (const block of barrel.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const name of (block[1] as string).split(',')) {
        if (name.trim()) {
          names.add(name.trim());
        }
      }
    }

    // more than a couple, or the reader above matched nothing and this is vacuous
    expect(names.size).toBeGreaterThan(10);

    const from = readme.indexOf('## Config files');
    const catalog = readme.indexOf('### `sigil/config`');
    const prose =
      readme.slice(from, readme.indexOf('## Subpath modules', from)) +
      readme.slice(catalog, readme.indexOf('\n### ', catalog + 1));

    expect([...names].filter((name) => !prose.includes(name))).to.deep.equal([]);
  });

  it('should draw WriteOptions whole, since a store is copied from that fence', () => {
    // the fence says `ConfigStore` is "drawn whole" and named `WriteOptions`
    // without showing it, so a store copied from it stopped at `lossy` -- and a
    // store that ignores `paths` has round 1's revert-another-process's-key
    // defect back. Read off the real type, so a field added without a fence entry
    // fails here. Found by review
    const types = readFileSync(join(import.meta.dirname, '../../src/config/types.ts'), 'utf8');
    const body = types.slice(types.indexOf('export interface WriteOptions {'));
    // the indentation is not spelled, for the reason a test never spells a path
    // separator: a pattern that pins the formatter's choice matches nothing the
    // day that choice moves, and an empty `fields` is a vacuous pass below
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^[ \t]+(\w+)\?:/gm)].map(
      (it) => it[1] as string
    );

    // two today, and a floor so the reader above cannot go quiet
    expect(fields).to.have.length.greaterThan(1);

    const fence = fenced('ts', 'interface WritableConfigStore');
    expect(fence).to.contain('interface WriteOptions {');
    expect(fields.filter((name) => !fence.includes(`${name}?:`))).to.deep.equal([]);
  });

  it('should read the store table the way it reads', () => {
    // `object()` -- the in-memory override layer
    expect(object().format).to.equal('object');
    expect(object().readSync().value).to.deep.equal({});
    // `json(path)` -- a JSON file, read as JSONC whatever it is called
    expect(json(join(root, 'x.json')).format).to.equal('jsonc');
    for (const name of ['y.json', 'y.jsonc']) {
      writeFileSync(join(root, name), '{ /* hi */ "a": 1, }');
      expect(json(join(root, name)).readSync().value, name).to.deep.equal({ a: 1 });
    }
  });

  it('should be able to name a layer the way the README spells it', () => {
    // `configHome('myapp', 'config.jsonc')`, which is the renamed `paths.config()`
    const path = configHome('myapp', 'config.jsonc');
    expect(path).to.be.a('string');
    expect(path).to.not.contain('~');
  });

  it('should hand back something structuredClone can copy', () => {
    // "`structuredClone()` is how to take a mutable copy" -- which is only true
    // if what `get()` answers is cloneable, and a frozen object is
    const config = createConfigSync({
      layers: [{ name: 'a', store: object({ a: { b: [1, 2] } }) }],
      env: {},
    });

    const copy = structuredClone(config.get('a')) as Record<string, unknown>;
    expect(copy).to.deep.equal({ b: [1, 2] });
    expect(Object.isFrozen(copy)).to.equal(false);
    copy.b = [3];
    expect(config.get('a.b')).to.deep.equal([1, 2]);
  });
});
