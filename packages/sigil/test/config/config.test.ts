import {
	createConfig,
	createConfigSync,
	isWritableStore,
	json,
	jsonc,
	object,
	type ConfigDocument,
	type ConfigSchema,
	type ConfigStore,
	type WritableConfigStore,
} from '../../src/config/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'sigil-config-'));
});

afterEach(() => {
	rmSync(root, { force: true, recursive: true });
});

/** Writes a file under the scratch root and answers with its path. */
function file(name: string, contents: string): string {
	const path = join(root, name);
	writeFileSync(path, contents);
	return path;
}

describe('the layer stack', () => {
	it('should let a later layer win over an earlier one', async () => {
		// array order read the way document order is paint order everywhere else
		// here: the last entry is on top
		const config = await createConfig({
			layers: [
				{ name: 'defaults', store: object({ a: 1, b: 2 }) },
				{ name: 'user', store: object({ b: 3 }) },
			],
		});

		expect(config.get('a')).to.equal(1);
		expect(config.get('b')).to.equal(3);
	});

	it('should merge plain objects key by key rather than replacing them', async () => {
		const config = await createConfig({
			layers: [
				{ name: 'defaults', store: object({ server: { host: 'localhost', port: 80 } }) },
				{ name: 'user', store: object({ server: { port: 8080 } }) },
			],
		});

		expect(config.get('server')).to.deep.equal({ host: 'localhost', port: 8080 });
	});

	it('should replace an array rather than merging it', async () => {
		// the less surprising of the two: a user writing `exclude: [...]` means
		// "this is my list", not "append mine to whatever shipped"
		const config = await createConfig({
			layers: [
				{ name: 'defaults', store: object({ exclude: ['a', 'b'] }) },
				{ name: 'user', store: object({ exclude: ['c'] }) },
			],
		});

		expect(config.get('exclude')).to.deep.equal(['c']);
	});

	it('should concatenate an array where the schema said to, bottom first', async () => {
		const config = await createConfig({
			schema: { plugins: { merge: 'concat', multiple: true } },
			layers: [
				{ name: 'defaults', store: object({ plugins: ['a'] }) },
				{ name: 'user', store: object({ plugins: ['b'] }) },
			],
		});

		expect(config.get('plugins')).to.deep.equal(['a', 'b']);
	});

	it('should concatenate at a nested path too', async () => {
		// the `concat` lookup is asked with the **dotted** path, built as the merge
		// walks down -- so a top-level setting cannot tell a correct lookup from one
		// that forgot the parent. Found by a sabotage that survived every other
		// concat test
		const config = await createConfig({
			schema: { 'server.tags': { merge: 'concat', multiple: true } },
			layers: [
				{ name: 'low', store: object({ server: { tags: ['a'] } }) },
				{ name: 'high', store: object({ server: { tags: ['b'] } }) },
			],
		});

		expect(config.get('server.tags')).to.deep.equal(['a', 'b']);
	});

	it('should not concatenate a differently named path that shares a leaf', async () => {
		// the other direction: a bare `tags` is not `server.tags`
		const config = await createConfig({
			schema: { 'server.tags': { merge: 'concat', multiple: true } },
			layers: [
				{ name: 'low', store: object({ tags: ['a'] }) },
				{ name: 'high', store: object({ tags: ['b'] }) },
			],
		});

		expect(config.get('tags')).to.deep.equal(['b']);
	});

	it('should replace a class instance rather than merging into it', async () => {
		// merging into one makes no sense -- what would the result be an instance
		// of -- so the structure this module owns is plain objects and arrays
		const when = new Date(0);
		const config = await createConfig({
			layers: [
				{ name: 'a', store: object({ at: { nested: 1 } }) },
				{ name: 'b', store: object({ at: when }) },
			],
		});

		expect(config.get('at')).to.equal(when);
	});

	it('should answer with the whole view when asked for no path', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ x: 1 }) }],
		});

		expect(config.get()).to.deep.equal({ x: 1 });
	});

	it('should answer with an object for a config with no layers at all', async () => {
		const config = await createConfig();
		expect(config.get()).to.deep.equal({});
		expect(config.get('anything')).to.equal(undefined);
	});

	it('should report each layer for diagnostics', async () => {
		const path = file('c.json', '{"a":1}');
		const config = await createConfig({
			layers: [
				{ name: 'system', readOnly: true, store: json(path) },
				{ name: 'runtime', store: object() },
			],
		});

		expect(config.layers).to.deep.equal([
			{
				format: 'json',
				name: 'system',
				readOnly: true,
				source: path,
				wouldLose: undefined,
			},
			{
				format: 'object',
				name: 'runtime',
				readOnly: false,
				source: undefined,
				wouldLose: undefined,
			},
		]);
	});
});

describe('dotted paths', () => {
	it('should read a nested path', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ a: { b: { c: 1 } } }) }],
		});

		expect(config.get('a.b.c')).to.equal(1);
		expect(config.get('a.b')).to.deep.equal({ c: 1 });
		expect(config.get('a.b.c.d')).to.equal(undefined);
		expect(config.get('nope.nothing')).to.equal(undefined);
	});

	it('should answer has() exactly where get() answers', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ empty: '', zero: 0, off: false }) }],
		});

		// a key written `""` is an empty string somebody chose, and `0` and `false`
		// are values -- only absent is not configured
		expect(config.has('empty')).to.equal(true);
		expect(config.has('zero')).to.equal(true);
		expect(config.has('off')).to.equal(true);
		expect(config.has('nope')).to.equal(false);
	});

	it('should read a null as not configured at an undeclared path too', async () => {
		// the rule used to live where a setting was validated, so it was **only**
		// true of a declared one: `{ "x": null }` with no schema answered `null`
		// and `has('x')` was `true`, which this module's own rule contradicts.
		// Found by review
		const config = await createConfig({
			layers: [{ name: 'f', store: object({ x: null, y: { z: null }, keep: '' }) }],
		});

		expect(config.has('x')).to.equal(false);
		expect(config.get('x')).to.equal(undefined);
		expect(config.get('y')).to.deep.equal({});
		// `""` is still an empty string somebody chose
		expect(config.get('keep')).to.equal('');
	});

	it('should keep a null inside an array, which is data rather than nothing', async () => {
		const config = await createConfig({
			layers: [{ name: 'f', store: object({ list: [1, null, 2] }) }],
		});

		expect(config.get('list')).to.deep.equal([1, null, 2]);
	});

	it('should read a set of null as the delete it is', async () => {
		// `null` means "not configured" wherever it is written, so writing one is
		// `delete()` said another way -- and the alternative is a `set()` whose
		// result a re-read of the same file would not reproduce
		const config = await createConfig({
			layers: [
				{ name: 'low', store: object({ a: 1 }) },
				{ name: 'high', store: object({ a: 2 }) },
			],
		});

		config.set('a', null);
		expect(config.get('a')).to.equal(1);
	});

	it('should read a key absent and a key set to null as both not configured', async () => {
		const config = await createConfig({
			schema: { 'editor.theme': { type: 'string', default: 'dark' } },
			layers: [{ name: 'user', store: object({ editor: { theme: null } }) }],
		});

		// `null` is removed rather than kept: left in place it would be a value,
		// and a value replaces the layer under it, so the user would be shadowing
		// the default to `null` rather than falling back to it
		expect(config.has('editor.theme')).to.equal(true);
		expect(config.get('editor.theme')).to.equal('dark');
	});

	it('should not answer with a member every object inherits', async () => {
		// `readPath()` asks `Object.hasOwn` for exactly this: on a plain object
		// `toString` and `hasOwnProperty` read back truthy, which is the hazard
		// this repository already has three entries about -- the parser's
		// registries, the style property tables, the palette's two lookups.
		// `constructor` is refused as a path segment outright; these two are not,
		// so the own-property check is what answers them
		const config = await createConfig({ layers: [{ name: 'a', store: object({}) }] });

		expect(config.get('toString')).to.equal(undefined);
		expect(config.get('hasOwnProperty')).to.equal(undefined);
		expect(config.get('valueOf')).to.equal(undefined);
		expect(config.has('toString')).to.equal(false);
		expect(config.get('a.toString')).to.equal(undefined);
	});

	it('should refuse a path with an empty segment', async () => {
		const config = await createConfig();
		expect(() => config.get('a..b')).toThrow(/empty segment/);
	});
});

describe('the prototype guard', () => {
	// the sharpest form of a hazard this repository already has three entries
	// about, and a dotted path can arrive from a file in a repository somebody
	// cloned
	it.each([['__proto__.x'], ['constructor.prototype.x'], ['a.__proto__.x'], ['prototype']])(
		'should refuse %s as a path',
		async (path) => {
			const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
			expect(() => config.set(path, 1)).toThrow(/not a safe key/);
			expect(() => config.get(path)).toThrow(/not a safe key/);
			expect(() => config.delete(path)).toThrow(/not a safe key/);
		}
	);

	it('should not pollute Object.prototype through a set', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(() => config.set('__proto__.polluted', 'yes')).toThrow();
		expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
	});

	it('should refuse an unsafe key in a file', async () => {
		// `JSON.parse` puts `__proto__` on an object as an own property rather than
		// through the accessor, so a file holding one is read without incident --
		// and then the first `Object.assign({}, config.get('x'))` an app writes
		// triggers the setter
		const path = file('c.json', '{"__proto__":{"polluted":"yes"}}');
		await expect(createConfig({ layers: [{ name: 'user', store: json(path) }] })).rejects.toThrow(
			/Unsafe config key/
		);
		expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
	});

	it('should refuse an unsafe key nested in a file', async () => {
		const path = file('c.json', '{"a":{"b":{"constructor":1}}}');
		await expect(createConfig({ layers: [{ name: 'user', store: json(path) }] })).rejects.toThrow(
			/Unsafe config key "constructor"/
		);
	});

	it('should refuse an unsafe key in an object layer', async () => {
		await expect(
			createConfig({
				layers: [{ name: 'a', store: object(JSON.parse('{"__proto__":{"x":1}}')) }],
			})
		).rejects.toThrow(/Unsafe config key/);
	});

	// the **third** door, and the one the first version missed: a `type: 'json'`
	// or `type: 'auto'` value enters as a *string*, which has no keys to refuse,
	// and becomes an object with an own `__proto__` after the ingest copy. The
	// merge's own copy then did `out['__proto__'] = ...` on a fresh `{}` and set
	// its prototype, so `config.get('data').polluted` was `true` and the value was
	// not even frozen. Found by review
	it.each([['json'], ['auto']])(
		'should refuse an unsafe key a %s string parses into',
		async (type) => {
			const payload = '{"__proto__":{"polluted":true}}';
			await expect(
				createConfig({
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					schema: { data: { type: type as any } },
					layers: [{ name: 'user', store: object({ data: payload }) }],
				})
			).rejects.toThrow(/Unsafe config key "__proto__" in user/);
		}
	);

	it('should refuse an unsafe key an environment variable parses into', async () => {
		await expect(
			createConfig({
				env: { DATA: '{"__proto__":{"polluted":true}}' },
				schema: { data: { env: 'DATA', type: 'json' } },
			})
		).rejects.toThrow(/Unsafe config key "__proto__" in setting "data"/);
	});

	it('should refuse an unsafe key in a schema default', async () => {
		await expect(
			createConfig({
				schema: {
					data: { default: JSON.parse('{"__proto__":{"polluted":true}}') as object, type: 'json' },
				},
			})
		).rejects.toThrow(/Unsafe config key "__proto__" in setting "data"/);
	});

	it('should leave no polluted prototype on anything it handed out', async () => {
		// the property rather than the refusal: whatever the doors do, nothing
		// `get()` answers with may have a prototype that is not `Object.prototype`
		const config = await createConfig({
			schema: { data: { type: 'json' } },
			layers: [{ name: 'user', store: object({ data: '{"a":1}' }) }],
		});

		const got = config.get('data') as Record<string, unknown>;
		expect(Object.getPrototypeOf(got)).to.equal(Object.prototype);
		expect(got.polluted).to.equal(undefined);
		expect(Object.isFrozen(got)).to.equal(true);
	});

	it('should refuse an unsafe setting path in a schema', async () => {
		await expect(createConfig({ schema: { '__proto__.x': { type: 'int' } } })).rejects.toThrow(
			/not a usable config path/
		);
	});
});

describe('set and delete', () => {
	it('should write to the topmost writable layer by default', async () => {
		// writing to a lower one means `get()` does not change, which is a
		// mutation that looks like it did nothing
		const config = await createConfig({
			layers: [
				{ name: 'low', store: object({ a: 1 }) },
				{ name: 'high', store: object({}) },
			],
		});

		config.set('a', 2);
		expect(config.get('a')).to.equal(2);
	});

	it('should skip a read-only layer when picking one', async () => {
		const config = await createConfig({
			layers: [
				{ name: 'low', store: object({}) },
				{ name: 'high', readOnly: true, store: object({}) },
			],
		});

		config.set('a', 1);
		expect(config.get('a')).to.equal(1);
	});

	it('should write to a named layer', async () => {
		const config = await createConfig({
			layers: [
				{ name: 'low', store: object({}) },
				{ name: 'high', store: object({ a: 'wins' }) },
			],
		});

		config.set('a', 'under', 'low');
		expect(config.get('a')).to.equal('wins');
		config.delete('a', 'high');
		expect(config.get('a')).to.equal('under');
	});

	it('should make the objects on the way down', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		config.set('a.b.c', 1);
		expect(config.get()).to.deep.equal({ a: { b: { c: 1 } } });
	});

	it('should prune the objects a delete emptied', async () => {
		// an empty object is a difference the merged view can see
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ a: { b: { c: 1 } } }) }],
		});

		expect(config.delete('a.b.c')).to.equal(true);
		expect(config.get()).to.deep.equal({});
	});

	it('should answer false for a delete of nothing', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(config.delete('nope')).to.equal(false);
	});

	it('should refuse a mutator with no path, naming apply()', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(() => config.set('', 1)).toThrow(/use apply\(\)/);
		expect(() => config.delete('')).toThrow(/use apply\(\)/);
	});

	it('should refuse a named layer that is not there, naming what there is', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(() => config.set('x', 1, 'nope')).toThrow(/Unknown config layer "nope".*"a"/s);
	});

	it('should refuse a config with no writable layer, naming the fix', async () => {
		const path = file('c.json', '{}');
		const config = await createConfig({ layers: [{ name: 'system', store: json(path) }] });
		expect(() => config.set('x', 1)).toThrow(/No writable config layer.*object\(\)/s);
	});

	it('should refuse a write to a layer declared read-only', async () => {
		const config = await createConfig({
			layers: [{ name: 'system', readOnly: true, store: object({}) }],
		});
		expect(() => config.set('x', 1, 'system')).toThrow(/layer "system" is read-only/);
	});
});

describe('deleting a value that lives in a read-only layer', () => {
	// not a tombstone: TOML cannot represent one, it is a new value concept every
	// store must support, and it needs a sentinel that can collide with a `null`
	// the user wrote. The useful half already works -- `set()` shadows -- and what
	// cannot be expressed is shadowing to *absent*
	it('should throw, naming the layer and both ways out', async () => {
		const system = file('system.json', '{"editor":{"theme":"light"}}');
		const user = file('user.json', '{}');

		const config = await createConfig({
			layers: [
				{ name: '<system defaults>', readOnly: true, store: json(system) },
				{ name: 'user', store: object({}) },
			],
		});

		let message = '';
		try {
			config.delete('editor.theme');
		} catch (e: unknown) {
			message = (e as Error).message;
		}

		expect(message).to.contain('Cannot delete "editor.theme"');
		expect(message).to.contain('<system defaults>');
		expect(message).to.contain('which is read-only');
		expect(message).to.contain('to override the value');
		expect(message).to.contain(system);
		expect(user).to.be.a('string');
	});

	it('should name the writable layer by its source where it has one', async () => {
		const system = file('system.json', '{"a":1}');
		const path = join(root, 'user.json');

		const config = await createConfig({
			layers: [
				{ name: 'system', readOnly: true, store: json(system) },
				{ name: 'user', store: object({}) },
			],
		});

		// an object store has no source, so the message falls back to the layer's
		// own name -- which is the honest answer rather than a path that is not one
		expect(() => config.delete('a')).toThrow(/Set it in user to override/);
		expect(path).to.be.a('string');
	});

	it('should shadow rather than delete, which is the half that works', async () => {
		const system = file('system.json', '{"editor":{"theme":"light"}}');
		const config = await createConfig({
			layers: [
				{ name: 'system', readOnly: true, store: json(system) },
				{ name: 'user', store: object({}) },
			],
		});

		config.set('editor.theme', 'dark');
		expect(config.get('editor.theme')).to.equal('dark');
	});

	it('should leave a delete of something it does hold alone', async () => {
		const system = file('system.json', '{"a":1}');
		const config = await createConfig({
			layers: [
				{ name: 'system', readOnly: true, store: json(system) },
				{ name: 'user', store: object({ a: 2 }) },
			],
		});

		// the throw is for a path the writable layer has nothing at. Here it has
		// something, so the delete works -- and `get()` then answers from the
		// read-only layer, which is the merge rather than a surprise
		expect(config.delete('a')).to.equal(true);
		expect(config.get('a')).to.equal(1);
	});
});

describe('the array methods', () => {
	it('should push and unshift into the named layer', async () => {
		const config = await createConfig({
			layers: [{ name: 'user', store: object({ list: ['b'] }) }],
		});

		expect(config.push('list', 'c')).to.equal(2);
		expect(config.unshift('list', 'a')).to.equal(3);
		expect(config.get('list')).to.deep.equal(['a', 'b', 'c']);
	});

	it('should pop and shift from the named layer', async () => {
		const config = await createConfig({
			layers: [{ name: 'user', store: object({ list: ['a', 'b', 'c'] }) }],
		});

		expect(config.pop('list')).to.equal('c');
		expect(config.shift('list')).to.equal('a');
		expect(config.get('list')).to.deep.equal(['b']);
	});

	it('should make a list where the layer had none', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(config.push('list', 1)).to.equal(1);
		expect(config.get('list')).to.deep.equal([1]);
	});

	it('should answer undefined for a pop of nothing', async () => {
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });
		expect(config.pop('nope')).to.equal(undefined);
		expect(config.shift('nope')).to.equal(undefined);
	});

	it('should refuse to push onto something that is not a list', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ x: 'scalar' }) }],
		});

		// one key for all four methods rather than the method name through a slot
		expect(() => config.push('x', 1)).toThrow(/"x" in a is not a list/);
		expect(() => config.pop('x')).toThrow(/"x" in a is not a list/);
		expect(() => config.unshift('x', 1)).toThrow(/is not a list/);
		expect(() => config.shift('x')).toThrow(/is not a list/);
	});

	it('should append to that layer rather than to the merged list', async () => {
		// seeding from the merged value would copy a lower layer's values into this
		// one, after which a change to the defaults never reaches the user again
		const config = await createConfig({
			layers: [
				{ name: 'defaults', store: object({ list: ['a'] }) },
				{ name: 'user', store: object({}) },
			],
		});

		config.push('list', 'b');
		expect(config.get('list')).to.deep.equal(['b']);
	});

	it('should read as appending to the merged list where the schema said concat', async () => {
		const config = await createConfig({
			schema: { list: { merge: 'concat', multiple: true } },
			layers: [
				{ name: 'defaults', store: object({ list: ['a'] }) },
				{ name: 'user', store: object({}) },
			],
		});

		config.push('list', 'b');
		expect(config.get('list')).to.deep.equal(['a', 'b']);
	});

	it('should not let a push reach back into what the merge handed out', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ list: ['x'] }) }],
		});

		const before = config.get('list') as unknown[];
		config.push('list', 'y');
		expect(before).to.deep.equal(['x']);
		expect(config.get('list')).to.deep.equal(['x', 'y']);
	});
});

describe('apply()', () => {
	it('should replace a layer rather than merging into it', async () => {
		// a merge inside a layer would be a second merge semantics beside the
		// cross-layer one, and two objects that should merge are two layers
		const config = await createConfig({
			layers: [{ name: 'user', store: object({ a: 1, b: 2 }) }],
		});

		config.apply('user', { b: 3 });
		expect(config.get()).to.deep.equal({ b: 3 });
	});

	it('should keep the layers under it', async () => {
		const config = await createConfig({
			layers: [
				{ name: 'defaults', store: object({ a: 1 }) },
				{ name: 'user', store: object({ b: 2 }) },
			],
		});

		config.apply('user', { c: 3 });
		expect(config.get()).to.deep.equal({ a: 1, c: 3 });
	});

	it('should apply to a read-only layer, which is a reload rather than a write', async () => {
		// `apply()` is how an app re-reads its own config, and a read-only layer is
		// one this process must not *write* -- re-reading it is not writing it
		const config = await createConfig({
			layers: [{ name: 'system', readOnly: true, store: object({ a: 1 }) }],
		});

		config.apply('system', { a: 2 });
		expect(config.get('a')).to.equal(2);
	});

	it('should validate what it was handed', async () => {
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'user', store: object({}) }],
		});

		expect(() => config.apply('user', { port: 'nope' })).toThrow(/Invalid value for "port"/);
		expect(() => config.apply('user', [])).toThrow(/not an object/);
	});

	it('should refuse a layer that is not there', async () => {
		const config = await createConfig();
		expect(() => config.apply('nope', {})).toThrow(/Unknown config layer "nope"/);
	});

	it('should coerce what it was handed', async () => {
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'user', store: object({}) }],
		});

		config.apply('user', { port: '8080' });
		expect(config.get('port')).to.equal(8080);
	});
});

describe('the merged view', () => {
	it('should be frozen, because it is a computed value', async () => {
		// mutating it would change what a later `get()` answers while changing no
		// layer, which is a value with no writer
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ a: { b: [1] } }) }],
		});

		const view = config.get() as Record<string, unknown>;
		expect(Object.isFrozen(view)).to.equal(true);
		expect(Object.isFrozen(view.a)).to.equal(true);
		expect(Object.isFrozen((view.a as Record<string, unknown>).b)).to.equal(true);
	});

	it('should not freeze a value the app handed in', async () => {
		// freezing a `Date` or a function on the way past would be freezing
		// somebody else's object
		const when = new Date(0);
		const fn = (): number => 1;
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ when, fn }) }],
		});

		expect(config.get('when')).to.equal(when);
		expect(Object.isFrozen(when)).to.equal(false);
		expect(Object.isFrozen(fn)).to.equal(false);
	});

	it('should not let a layer reach back into the object it was built from', async () => {
		// the rule `initCommand()` already keeps: copies, never decorates
		const source = { a: 1 };
		const config = await createConfig({ layers: [{ name: 'a', store: object(source) }] });

		config.set('a', 2);
		expect(source.a).to.equal(1);

		source.a = 99;
		expect(config.get('a')).to.equal(2);
	});

	it('should not let a set reach back into the value it was handed', async () => {
		const value = { nested: 1 };
		const config = await createConfig({ layers: [{ name: 'a', store: object() }] });

		config.set('x', value);
		value.nested = 99;
		expect(config.get('x')).to.deep.equal({ nested: 1 });
	});
});

describe('both entry points', () => {
	it('should answer the same for every core store', () => {
		const path = file('c.jsonc', '{ /* hi */ "a": 1, }');
		const layers = [
			{ name: 'defaults', store: object({ b: 2 }) },
			{ name: 'user', store: jsonc(path) },
		];

		const sync = createConfigSync({ layers });
		expect(sync.get()).to.deep.equal({ a: 1, b: 2 });
	});

	it('should really be synchronous rather than awaiting a settled promise', () => {
		// `then()` runs on a later microtask whatever the promise holds, so a sync
		// entry point written in terms of the async one would not be one
		const path = file('c.json', '{"a":1}');
		const config = createConfigSync({ layers: [{ name: 'a', store: json(path) }] });
		expect(config.get('a')).to.equal(1);
	});

	it('should use readSync() rather than read() for the sync half', () => {
		const calls: string[] = [];
		const store: ConfigStore = {
			format: 'probe',
			read(): Promise<ConfigDocument> {
				calls.push('read');
				return Promise.resolve({ value: {} });
			},
			readSync(): ConfigDocument {
				calls.push('readSync');
				return { value: { a: 1 } };
			},
		};

		createConfigSync({ layers: [{ name: 'a', store }] });
		expect(calls).to.deep.equal(['readSync']);
	});

	it('should use read() rather than readSync() for the async half', async () => {
		const calls: string[] = [];
		const store: ConfigStore = {
			format: 'probe',
			read(): Promise<ConfigDocument> {
				calls.push('read');
				return Promise.resolve({ value: { a: 1 } });
			},
			readSync(): ConfigDocument {
				calls.push('readSync');
				return { value: {} };
			},
		};

		await createConfig({ layers: [{ name: 'a', store }] });
		expect(calls).to.deep.equal(['read']);
	});

	it('should let a store that cannot do sync say so itself', () => {
		// strictly better than the optional shape: the failure is localized to the
		// store that has it and worded by the author who knows why, and no caller
		// branches
		const store: ConfigStore = {
			format: 'remote',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: {} }),
			readSync(): ConfigDocument {
				throw new Error('a remote config cannot be read synchronously');
			},
		};

		expect(() => createConfigSync({ layers: [{ name: 'a', store }] })).toThrow(
			/cannot be read synchronously/
		);
	});
});

describe('a layer declaration', () => {
	it.each([
		[undefined, /must be an object/],
		[{}, /must have a name/],
		[{ name: '' }, /must have a name/],
		[{ name: 'a' }, /needs a store/],
		[{ name: 'a', store: {} }, /needs a store/],
	])('should refuse %o', async (layer, message) => {
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createConfig({ layers: [layer as any] })
		).rejects.toThrow(message);
	});

	it('should refuse two layers of one name', async () => {
		// it makes `set(path, value, name)` ambiguous and every message about one
		// of them wrong about the other
		await expect(
			createConfig({
				layers: [
					{ name: 'a', store: object() },
					{ name: 'a', store: object() },
				],
			})
		).rejects.toThrow(/Duplicate config layer "a"/);
	});

	it('should refuse a store whose document is not an object', async () => {
		const store: ConfigStore = {
			format: 'odd',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: 42 }),
			readSync: (): ConfigDocument => ({ value: 42 }),
		};

		await expect(createConfig({ layers: [{ name: 'a', store }] })).rejects.toThrow(
			/read a value that is not an object/
		);
	});

	it('should read a store that answers nothing as an empty layer', async () => {
		const store: ConfigStore = {
			format: 'odd',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: undefined }),
			readSync: (): ConfigDocument => ({ value: null }),
		};

		expect(createConfigSync({ layers: [{ name: 'a', store }] }).get()).to.deep.equal({});
		expect((await createConfig({ layers: [{ name: 'a', store }] })).get()).to.deep.equal({});
	});
});

describe('the two refusals', () => {
	it('should narrow a writable store from a read-only one by type', () => {
		expect(isWritableStore(object())).to.equal(true);
		expect(isWritableStore(json(join(root, 'nope.json')))).to.equal(false);
	});

	it('should read a store that cannot write as a read-only layer', async () => {
		const config = await createConfig({
			layers: [{ name: 'system', store: json(join(root, 'nope.json')) }],
		});

		expect(config.layers[0]?.readOnly).to.equal(true);
	});

	it('should refuse a value the store says its format cannot hold', async () => {
		// TOML and `null` is the case this exists for, and it is synchronous
		// because `set()` is: refused at the call that wrote it rather than
		// discovered by a `save()` in an exit handler
		const store: WritableConfigStore = {
			canRepresent: (value: unknown): true | string =>
				value === null ? 'this format has no null' : true,
			format: 'toml-ish',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: {} }),
			readSync: (): ConfigDocument => ({ value: {} }),
			write: (): Promise<void> => Promise.resolve(),
			writeSync: (): void => undefined,
		};

		const config = await createConfig({ layers: [{ name: 'a', store }] });

		expect(() => config.set('x', null)).toThrow(/a cannot hold the value at "x"/);
		expect(() => config.set('x', null)).toThrow(/this format has no null/);
		config.set('x', 1);
		expect(config.get('x')).to.equal(1);
	});

	it('should ask canRepresent about a pushed value too', async () => {
		const seen: unknown[] = [];
		const store: WritableConfigStore = {
			canRepresent: (value: unknown): true => {
				seen.push(value);
				return true;
			},
			format: 'probe',
			read: (): Promise<ConfigDocument> => Promise.resolve({ value: {} }),
			readSync: (): ConfigDocument => ({ value: {} }),
			write: (): Promise<void> => Promise.resolve(),
			writeSync: (): void => undefined,
		};

		const config = await createConfig({ layers: [{ name: 'a', store }] });
		config.push('list', 'one');
		expect(seen).to.deep.equal(['one']);
	});

	it('should carry what a store says it would lose', async () => {
		const store: ConfigStore = {
			format: 'yaml-ish',
			read: (): Promise<ConfigDocument> =>
				Promise.resolve({
					value: {},
					wouldLose: [{ kind: 'anchor', line: 3, detail: '&base' }],
				}),
			readSync: (): ConfigDocument => ({ value: {} }),
		};

		const config = await createConfig({ layers: [{ name: 'a', store }] });
		expect(config.layers[0]?.wouldLose).to.deep.equal([
			{ kind: 'anchor', line: 3, detail: '&base' },
		]);
	});
});

describe('the schema', () => {
	it('should coerce a value that arrived as a string', async () => {
		// which is what makes an all-strings format work at all: XML has no other
		// scalar kind
		const config = await createConfig({
			schema: { 'server.port': { type: 'int' } },
			layers: [{ name: 'a', store: object({ server: { port: '8080' } }) }],
		});

		expect(config.get('server.port')).to.equal(8080);
	});

	it('should keep a value that arrived already typed', async () => {
		const config = await createConfig({
			schema: { 'server.port': { type: 'int' } },
			layers: [{ name: 'a', store: object({ server: { port: 8080 } }) }],
		});

		expect(config.get('server.port')).to.equal(8080);
	});

	it('should refuse a value the type cannot hold, naming the setting and the layer', async () => {
		await expect(
			createConfig({
				schema: { 'server.port': { type: 'int' } },
				layers: [{ name: 'user', store: object({ server: { port: 8080.5 } }) }],
			})
		).rejects.toThrow(/Invalid value for "server\.port" in user/);
	});

	it('should refuse a value outside its choices', async () => {
		await expect(
			createConfig({
				schema: { theme: { choices: ['light', 'dark'] } },
				layers: [{ name: 'user', store: object({ theme: 'mauve' }) }],
			})
		).rejects.toThrow(/Invalid value "mauve" for setting "theme"/);
	});

	it('should refuse a scalar where a list was declared', async () => {
		// the parser wraps an environment value because argv and the environment
		// can only hand over one value at a time; a file can write a list
		await expect(
			createConfig({
				schema: { plugins: { multiple: true } },
				layers: [{ name: 'user', store: object({ plugins: 'one' }) }],
			})
		).rejects.toThrow(/Expected a list of values/);
	});

	it('should check every element of a list', async () => {
		await expect(
			createConfig({
				schema: { ports: { multiple: true, type: 'int' } },
				layers: [{ name: 'user', store: object({ ports: [1, 'two'] }) }],
			})
		).rejects.toThrow(/Invalid integer: two/);
	});

	it('should leave a path the schema does not declare exactly as it arrived', async () => {
		// the call `allowUnknownOptions` already makes for argv: a config file
		// legitimately holds things this app's schema has nothing to say about
		const config = await createConfig({
			schema: { known: { type: 'int' } },
			layers: [{ name: 'a', store: object({ known: '1', plugin: { whatever: 'x' } }) }],
		});

		expect(config.get('known')).to.equal(1);
		expect(config.get('plugin.whatever')).to.equal('x');
	});

	it('should put a default under every layer', async () => {
		const config = await createConfig({
			schema: { 'server.port': { default: 8080, type: 'int' } },
		});

		// materialized rather than consulted on a miss, so that `get('server')`
		// holds a defaulted `server.port`
		expect(config.get('server.port')).to.equal(8080);
		expect(config.get('server')).to.deep.equal({ port: 8080 });
	});

	it('should let any layer beat a default', async () => {
		const config = await createConfig({
			schema: { port: { default: 8080, type: 'int' } },
			layers: [{ name: 'user', store: object({ port: 3000 }) }],
		});

		expect(config.get('port')).to.equal(3000);
	});

	it('should coerce a string default and leave every other kind alone', async () => {
		// the parser's own call said again: non-string defaults pass through
		// untouched, because the author wrote it in code in the right type
		const config = await createConfig({
			schema: {
				bare: { default: { nested: 1 }, type: 'json' },
				written: { default: '8080', type: 'int' },
			},
		});

		expect(config.get('written')).to.equal(8080);
		expect(config.get('bare')).to.deep.equal({ nested: 1 });
	});

	// what a `default` does is `applyFallback()`'s behaviour, measured on a real
	// parse rather than read off the code -- because two of the three answers are
	// not what a reading of "non-string defaults pass through untouched" predicts
	it('should wrap a scalar default for a multiple setting, as the parser does', async () => {
		// a declaration can only write one value, and the wrap is what makes the
		// shape not depend on how many were written
		const config = await createConfig({
			schema: {
				one: { default: 'a', multiple: true },
				many: { default: ['a', 'b'], multiple: true },
			},
		});

		expect(config.get('one')).to.deep.equal(['a']);
		expect(config.get('many')).to.deep.equal(['a', 'b']);
	});

	it('should refuse a default outside its choices, as the parser does', async () => {
		// a `default` is a producer, and the rule is that a value is validated by
		// whoever produced it
		await expect(
			createConfig({ schema: { mode: { choices: ['a', 'b'], default: 'z' } } })
		).rejects.toThrow(/Invalid value "z" for setting "mode"/);
	});

	it('should leave a non-string default the type cannot hold alone, as the parser does', async () => {
		// the one place this is looser than it could be, and diverging would make
		// the two declarations disagree about a value written in code: the parser
		// hands `8080.5` to an `int` option untouched, because the author wrote it
		// in the right type
		const config = await createConfig({ schema: { port: { default: 8080.5, type: 'int' } } });
		expect(config.get('port')).to.equal(8080.5);
	});

	it.each([
		[{ x: { type: 'nope' } }, /unsupported data type "nope"/],
		[{ x: { type: 'count' } }, /unsupported data type "count"/],
		[{ x: { choices: 'light' } }, /choices must be an array/],
		[{ x: { merge: 'append' } }, /merge must be "concat" or "replace"/],
		// `envNames()` spreads it, so a non-iterable reached `envOf()` as a
		// `TypeError: env is not iterable` -- an error about the wrong thing,
		// naming nothing. Found by review
		[{ x: { env: 42 } }, /env must be a variable name or an array of them/],
		[{ x: { env: {} } }, /env must be a variable name/],
		[{ x: { env: '' } }, /env must be a variable name/],
		[{ x: { env: ['OK', ''] } }, /env must be a variable name/],
		[{ x: 'nope' }, /must be an object/],
		[{ '': {} }, /must name a path/],
		[{ a: {}, 'a.b': {} }, /Setting "a\.b" is inside setting "a"/],
	])('should refuse the schema %o', async (schema, message) => {
		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			createConfig({ schema: schema as any })
		).rejects.toThrow(message);
	});

	it('should refuse a set the schema cannot hold, and leave the layer alone', async () => {
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'a', store: object({ port: 80 }) }],
		});

		expect(() => config.set('port', 'nope')).toThrow(/Invalid value for "port"/);
		// a refused `set()` over an existing value must not be a `delete()`
		expect(config.get('port')).to.equal(80);
	});

	it('should not let a refused set poison the next one', async () => {
		// the rollback is invisible through `get()` on the failing call, because a
		// refusal never recomputes -- so the merged view still answers what it
		// answered. What makes it visible is the **next** mutation: without the
		// restore the layer holds the value that was refused, and the recompute
		// that mutation triggers refuses it all over again. Found by a sabotage
		// that survived both of the obvious tests
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'a', store: object({ port: 80 }) }],
		});

		expect(() => config.set('port', 'nope')).toThrow(/Invalid value for "port"/);
		config.set('other', 1);
		expect(config.get()).to.deep.equal({ other: 1, port: 80 });
	});

	it('should put a refused value back rather than deleting it', async () => {
		// the other half of the same blindness: a rollback that *deleted* where
		// there had been a value passes every assertion about the failing call
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'a', store: object({ port: 80 }) }],
		});

		expect(() => config.set('port', 8080.5)).toThrow();
		config.set('other', 1);
		expect(config.get('port')).to.equal(80);
	});

	it('should name the setting when a coercion produces an unsafe key', async () => {
		// the coercion sites copy so that the message names the **setting** the
		// value came through, where the merge's own tripwire can only name the
		// layer. And the mutation rolls back either way, because the recompute is
		// inside the guard
		const config = await createConfig({
			schema: { data: { type: 'json' } },
			layers: [{ name: 'a', store: object({ data: { ok: 1 } }) }],
		});

		expect(() => config.set('data', '{"__proto__":{"polluted":true}}')).toThrow(
			/Invalid value for "data" in a: Unsafe config key "__proto__"/
		);
		expect(config.get('data')).to.deep.equal({ ok: 1 });

		// and the config still works, which is what the rollback is for
		config.set('other', 1);
		expect(config.get()).to.deep.equal({ data: { ok: 1 }, other: 1 });
	});

	it('should name the setting when a coercion produces an unsafe key in a list', async () => {
		// the `multiple` branch copies for the same reason the scalar one does, and
		// is a separate branch -- so a scalar fixture leaves it unpinned
		const config = await createConfig({
			schema: { items: { multiple: true, type: 'json' } },
			layers: [{ name: 'a', store: object({ items: ['{"ok":1}'] }) }],
		});

		expect(() => config.push('items', '{"__proto__":{"polluted":true}}')).toThrow(
			/Invalid value for "items" in a: Unsafe config key "__proto__"/
		);
		expect(config.get('items')).to.deep.equal([{ ok: 1 }]);
	});

	it('should leave nothing behind when a refused set made objects on the way down', async () => {
		const config = await createConfig({
			schema: { 'a.b': { type: 'int' } },
			layers: [{ name: 'x', store: object({}) }],
		});

		expect(() => config.set('a.b', 'nope')).toThrow();
		expect(config.get()).to.deep.equal({});
	});

	// a mutation validates the **whole** layer rather than the setting at its own
	// path, because a path can be *inside* a declared setting or *outside* one
	// declared under it -- and a pass that looked at its own path alone missed
	// both, leaving a layer in a state the load path says is impossible
	it('should refuse a set into a path inside a declared setting', async () => {
		// the path runs through an *object*, so the write guard has nothing to say
		// and the schema is what refuses: `{ server: { port: 1 } }` is not a
		// string, and `createConfig()` over a file holding it refuses outright --
		// so a `set()` that produced it would mean the next run of the same app
		// over the same file fails to start
		const config = await createConfig({
			schema: { server: { type: 'json' }, 'other.port': { type: 'int' } },
			layers: [{ name: 'a', store: object({ other: { port: 1 } }) }],
		});

		expect(() => config.set('other.port', 'nope')).toThrow(/Invalid value for "other\.port"/);
		expect(config.get('other.port')).to.equal(1);
	});

	it('should refuse a write whose way down is not an object', async () => {
		// `writePath()` used to **replace** it, which for an array is silent data
		// loss: `set('items.0', 9)` over `[1, 2, 3]` left `{ "0": 9 }` and the list
		// was gone. Refused rather than special-cased for arrays, because
		// `readPath()` does not walk one either -- so `get('items.0')` is
		// `undefined` until a `set()` has already destroyed the list
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ items: [1, 2, 3], server: 'off' }) }],
		});

		expect(() => config.set('items.0', 9)).toThrow(/"items" in a is not an object/);
		expect(() => config.set('server.port', 1)).toThrow(/"server" in a is not an object/);
		expect(() => config.push('items.0', 9)).toThrow(/"items" in a is not an object/);
		expect(config.get('items')).to.deep.equal([1, 2, 3]);
		expect(config.get('server')).to.equal('off');
	});

	it('should name the ancestor that is not an object, not the whole path', async () => {
		const config = await createConfig({
			layers: [{ name: 'a', store: object({ a: { b: 'scalar' } }) }],
		});

		expect(() => config.set('a.b.c.d', 1)).toThrow(/"a\.b" in a is not an object/);
	});

	it('should refuse a set over a path whose children are declared', async () => {
		const config = await createConfig({
			schema: { 'a.b': { type: 'int' } },
			layers: [{ name: 'x', store: object({}) }],
		});

		expect(() => config.set('a', { b: 'nope' })).toThrow(/Invalid value for "a\.b"/);
		expect(config.get()).to.deep.equal({});
	});

	it('should refuse a push the whole-layer pass catches', async () => {
		const config = await createConfig({
			schema: { 'a.list': { multiple: true, type: 'int' } },
			layers: [{ name: 'x', store: object({ a: {} }) }],
		});

		expect(() => config.push('a.list', 'nope')).toThrow(/Invalid value for "a\.list"/);
		expect(config.get()).to.deep.equal({ a: {} });
	});

	it('should leave a declared setting under an undeclared non-object alone', async () => {
		// the other half of "a path the schema does not declare is left as it
		// arrived": `a` is undeclared, so `a: [1, 2]` is a legal undeclared value
		// and `a.b` is simply absent. Declaring `a.b` does not constrain `a`,
		// because a config schema has no nested object shapes -- which is why the
		// toolchain keeps its own "build must be an object" check
		const config = await createConfig({
			schema: { 'a.b': { type: 'int' } },
			layers: [{ name: 'x', store: object({ a: [1, 2] }) }],
		});

		expect(config.get('a')).to.deep.equal([1, 2]);
		expect(config.has('a.b')).to.equal(false);
	});

	it('should coerce what a set wrote', async () => {
		const config = await createConfig({
			schema: { port: { type: 'int' } },
			layers: [{ name: 'a', store: object({}) }],
		});

		config.set('port', '8080');
		expect(config.get('port')).to.equal(8080);
	});

	it('should refuse a push the schema cannot hold, and leave the list alone', async () => {
		const config = await createConfig({
			schema: { ports: { multiple: true, type: 'int' } },
			layers: [{ name: 'a', store: object({ ports: [1] }) }],
		});

		expect(() => config.push('ports', 'nope')).toThrow(/Invalid integer/);
		expect(config.get('ports')).to.deep.equal([1]);
	});

	it('should leave nothing behind when a refused push made the list', async () => {
		const config = await createConfig({
			schema: { ports: { multiple: true, type: 'int' } },
			layers: [{ name: 'a', store: object({}) }],
		});

		expect(() => config.push('ports', 'nope')).toThrow();
		expect(config.get()).to.deep.equal({});
	});
});

describe("a setting's env", () => {
	const schema: ConfigSchema = { 'server.port': { env: 'PORT', type: 'int' } };

	it('should sit over every layer', async () => {
		// a variable is a statement about one run and a file is a persistent one,
		// which is the same reading argv gets against the environment one layer up
		const config = await createConfig({
			env: { PORT: '3000' },
			schema,
			layers: [{ name: 'user', store: object({ server: { port: 8080 } }) }],
		});

		expect(config.get('server.port')).to.equal(3000);
	});

	it('should read an empty variable as unset, which is the parser´s own rule', async () => {
		const config = await createConfig({
			env: { PORT: '' },
			schema,
			layers: [{ name: 'user', store: object({ server: { port: 8080 } }) }],
		});

		expect(config.get('server.port')).to.equal(8080);
	});

	it('should read a variable set to zero or a space as a value', async () => {
		// only the empty string is falsy among the values a variable can hold
		const zero = await createConfig({ env: { PORT: '0' }, schema });
		expect(zero.get('server.port')).to.equal(0);

		const blank = await createConfig({
			env: { SEP: ' ' },
			schema: { sep: { env: 'SEP', type: 'string' } },
		});
		expect(blank.get('sep')).to.equal(' ');
	});

	it('should try several variables in order', async () => {
		const config = await createConfig({
			env: { SECOND: 'b' },
			schema: { x: { env: ['FIRST', 'SECOND'] } },
		});

		expect(config.get('x')).to.equal('b');
	});

	it('should wrap one value into a list for a multiple setting', async () => {
		// `applyFallback()`'s rule: a variable can only hand over one value at a
		// time, so one value is the list
		const config = await createConfig({
			env: { PLUGINS: 'one' },
			schema: { plugins: { env: 'PLUGINS', multiple: true } },
		});

		expect(config.get('plugins')).to.deep.equal(['one']);
	});

	it('should concatenate over a layer where the schema said concat', async () => {
		const config = await createConfig({
			env: { PLUGINS: 'b' },
			schema: { plugins: { env: 'PLUGINS', merge: 'concat', multiple: true } },
			layers: [{ name: 'user', store: object({ plugins: ['a'] }) }],
		});

		expect(config.get('plugins')).to.deep.equal(['a', 'b']);
	});

	it('should coerce and check an environment value', async () => {
		await expect(createConfig({ env: { PORT: 'nope' }, schema })).rejects.toThrow(
			/Invalid integer: nope/
		);
		await expect(
			createConfig({
				env: { THEME: 'mauve' },
				schema: { theme: { choices: ['light'], env: 'THEME' } },
			})
		).rejects.toThrow(/Invalid value "mauve" for setting "theme"/);
	});

	it('should beat a set, because it is above every layer', async () => {
		const config = await createConfig({
			env: { PORT: '3000' },
			schema,
			layers: [{ name: 'user', store: object({}) }],
		});

		config.set('server.port', 8080);
		expect(config.get('server.port')).to.equal(3000);
	});
});
