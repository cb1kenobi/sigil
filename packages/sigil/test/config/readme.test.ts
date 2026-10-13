import { createConfig, createConfigSync, json, jsonc, object } from '../../src/config/index.js';
import { configHome } from '../../src/paths.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-readme-'));
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

describe("the README's own example", () => {
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
				{ name: 'user', store: jsonc(join(root, 'config.jsonc')) },
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
		// It named `user` until this test was written, and `user` is a file store
		// -- which this ticket does not make writable, so the line threw as
		// published. The whole reason to run the examples
		config.set('editor.theme', 'light', 'runtime');
		expect(config.get('editor.theme')).to.equal('light');
		expect(() => config.set('editor.theme', 'light', 'user')).toThrow(/read-only/);
		// `config.push('plugins', 'mine');`
		config.push('plugins', 'mine');
		expect(config.get('plugins')).to.deep.equal(['shipped', 'mine']);
		// `config.get('plugins')` reads as appending to the merged list, because
		// the schema said `concat`
		// `config.delete('editor.theme');`
		expect(config.delete('editor.theme')).to.equal(true);
		expect(config.has('editor.theme')).to.equal(false);
	});

	it('should mix an option with a setting the way the README says', () => {
		// `options: { '--port [n]': { type: 'int', default: config.get('server.port') } }`
		const config = createConfigSync({
			schema: { 'server.port': { type: 'int', default: 8080 } },
			env: {},
		});

		expect(config.get('server.port')).to.equal(8080);
		// which is what an app puts in a declaration, so it has to be a value the
		// parser's own `default` can take
		expect(typeof config.get('server.port')).to.equal('number');
	});

	it('should read the store table the way it reads', () => {
		// `object()` -- the in-memory override layer
		expect(object().format).to.equal('object');
		expect(object().readSync().value).to.deep.equal({});
		// `json(path)` -- strict, with comments reported
		expect(json(join(root, 'x.json')).format).to.equal('json');
		// `jsonc(path)` -- comments and trailing commas
		writeFileSync(join(root, 'y.jsonc'), '{ /* hi */ "a": 1, }');
		expect(jsonc(join(root, 'y.jsonc')).readSync().value).to.deep.equal({ a: 1 });
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
