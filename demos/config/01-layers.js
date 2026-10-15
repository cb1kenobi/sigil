import { createConfig, json, object } from '@ttylabs/sigil/config';
/**
 * One merged view over an ordered stack of layers: the merge, the schema, the
 * environment on top, and what `set()` does to one layer.
 *
 *   node demos/config/01-layers.js
 *   PORT=3000 node demos/config/01-layers.js     # a variable beats every file
 *   PORT= node demos/config/01-layers.js         # an empty variable is unset
 *   node demos/config/01-layers.js --bad         # what a wrong value says
 *
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// two files, written here so the demo is self-contained. An app's would be
// `/etc/myapp/config.json` and `paths.configHome('myapp', 'config.json')`
const root = mkdtempSync(join(tmpdir(), 'sigil-config-demo-'));
const system = join(root, 'system.json');
const user = join(root, 'config.json');

writeFileSync(
	system,
	JSON.stringify({
		editor: { theme: 'light', tabWidth: 4 },
		plugins: ['core'],
		server: { host: '0.0.0.0' },
	})
);

// a config file holds comments and trailing commas whatever it is called:
// `json()` reads a `.json` as JSONC, which is what `tsconfig.json` already is.
// The span writer keeps them, which is why the file is edited rather than
// reprinted
writeFileSync(
	user,
	`{
	// the one thing I changed
	"editor": { "theme": "dark" },
	"plugins": ["mine"],
}`
);

const bad = process.argv.includes('--bad');

// built before the `try`, so the only thing inside it that can throw before the
// body is `createConfig()` itself. With these calls in there, a mistake in one
// -- a renamed store, a typo -- was caught by the `catch` below and printed as a
// refusal in `--bad` mode, which is the masking that catch is gated against
const layers = [
	{ name: 'system', readOnly: true, store: json(system) },
	{ name: 'user', store: json(user) },
	// an object layer with nothing in it is the in-memory override: a run
	// that overrides a setting for its own duration and persists nothing
	{ name: 'runtime', store: object(bad ? { server: { port: 'eighty' } } : {}) },
];

try {
	const config = await createConfig({
		// config's own schema, declared by dotted path, in the parser's own type
		// vocabulary -- so this file and an option declaration cannot come to
		// disagree about what `on` means
		schema: {
			'editor.tabWidth': { type: 'int', default: 2 },
			'editor.theme': { type: 'string', choices: ['light', 'dark'], default: 'light' },
			// `concat` is opt-in per key. Without it an array *replaces*, which is
			// what a user writing their own list means
			plugins: { type: 'string', multiple: true, merge: 'concat' },
			'server.host': { type: 'string', default: '127.0.0.1' },
			'server.port': { type: 'int', default: 8080, env: 'PORT' },
		},
		// bottom first, so the last entry is on top
		layers,
	});

	console.log('the merged view');
	console.log(JSON.stringify(config.get(), null, 2));
	console.log();

	console.log('where each value came from');
	for (const [path, why] of [
		['editor.theme', 'the user file, over the system file'],
		['editor.tabWidth', 'the system file, over the schema default'],
		['server.host', 'the system file'],
		['server.port', process.env.PORT ? 'PORT, over everything' : 'the schema default'],
		['plugins', 'both files, concatenated bottom first'],
	]) {
		console.log(`  ${path.padEnd(16)} ${JSON.stringify(config.get(path))}  -- ${why}`);
	}
	console.log();

	// a key absent and a key set to `null` are both "not configured"; a key set
	// to `""` is an empty string somebody chose
	console.log('has()');
	console.log(`  editor.theme     ${config.has('editor.theme')}`);
	console.log(`  editor.nothing   ${config.has('editor.nothing')}`);
	console.log();

	// `set()` mutates ONE layer -- the topmost writable one unless told otherwise
	// -- because a merged value has no single home to write to
	config.set('editor.theme', 'light');
	config.push('plugins', 'from-set');
	console.log('after set() and push() into "runtime"');
	console.log(`  editor.theme     ${JSON.stringify(config.get('editor.theme'))}`);
	console.log(`  plugins          ${JSON.stringify(config.get('plugins'))}`);
	console.log();

	// `delete()` on a key only a read-only layer holds throws rather than
	// pretending: the message names the layer and both ways out
	console.log('delete() of a value the system file owns');
	try {
		config.delete('server.host');
	} catch (e) {
		for (const line of e.message.split('\n')) {
			console.log(`  ${line}`);
		}
	}
	console.log();

	// what `get()` hands back is frozen, because it is a computed value: mutating
	// it would change what a later `get()` answers while changing no layer
	console.log('the merged view is frozen');
	const view = config.get('editor');
	try {
		view.theme = 'mauve';
	} catch (e) {
		console.log(`  ${e.constructor.name}: ${e.message}`);
	}
	// printed either way, because the throw is strict mode's rather than this
	// module's: what the module promises is that the value did not move
	console.log(`  still ${JSON.stringify(config.get('editor.theme'))}`);
	console.log();

	// the system layer is read-only because this demo declares it so -- an
	// `/etc` file an app reads and must not touch. The user file is writable:
	// `json()` edits spans rather than reprinting, so a `save()` changes the
	// bytes it was asked to and leaves the comments alone
	console.log('the layers, for diagnostics');
	for (const layer of config.layers) {
		const where = layer.source ? layer.source.replace(root, '<tmp>') : '(in memory)';
		console.log(
			`  ${layer.name.padEnd(9)} ${layer.format.padEnd(7)} ${
				layer.readOnly ? 'read-only' : 'writable '
			} ${where}`
		);
	}
} catch (e) {
	// `--bad` is the mode that provokes this, and it is the only thing that can
	// reach here in that mode: the runtime layer holds a port the schema cannot
	// hold, so `createConfig()` always throws and the body below never runs. A
	// value a schema cannot hold names the setting, the layer and what was wrong
	// -- and it fails at construction rather than at the first `get()`.
	//
	// Rethrown in every other mode, which is the half a bare `catch` here cost:
	// a rename left a `jsonc(user)` call behind, and the ReferenceError came out
	// as `refused: jsonc is not defined` on stdout with exit 0, so
	// `demos.test.ts` passed over a broken demo. Gated on the mode rather than
	// removed, because removing it broke `--bad` -- the opposite mistake, found
	// by review
	if (!bad) {
		throw e;
	}

	console.log(`refused: ${e.message}`);
} finally {
	rmSync(root, { force: true, recursive: true });
}
