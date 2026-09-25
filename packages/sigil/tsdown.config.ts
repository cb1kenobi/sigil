import { defineConfig, type UserConfig } from 'tsdown';

/**
 * The control characters a terminal would act on, escaped in what ships.
 *
 * `src/ansi/codes.ts` builds `ESC` with `String.fromCharCode()` precisely so a
 * raw control character never sits in the source -- and the minifier constant-
 * folds that straight back into a raw byte, which undoes the care where nobody
 * was looking for it. It matters because a raw `ESC` in a *shipped* file is a
 * sequence waiting for something to print it, and Node prints the offending
 * source line on an uncaught error: a crash anywhere inside `style.mjs` wrote
 * `ESC ] 8 ; ;` to the user's terminal and left every line after it inside a
 * hyperlink that nothing ever closed. A CLI that dies must not take the
 * terminal with it, which is the rule the alternate screen and the cursor
 * already follow.
 *
 * `\t`, `\n` and `\r` are left alone: they are the file's own formatting, and a
 * terminal does nothing surprising with them. Everything else in C0, `DEL` and
 * C1 -- where U+009B is a CSI all by itself, and is in `codes.ts` -- becomes a
 * `\xNN` escape, which is the same string to JavaScript and inert to a
 * terminal. Asserted by `test/dist.test.ts`, because a build that quietly stops
 * doing this looks exactly like one that does.
 */
/**
 * Every control character, as a property rather than as a range.
 *
 * `\p{Cc}` is exactly C0, `DEL` and C1 -- the same set the class
 * `[\u0000-\u0008\u000B...]` spelled out, checked against all 1,112,064 code
 * points -- and it names what is being matched instead of enumerating it. It
 * carries no control character, escaped or otherwise, so `no-control-regex` has
 * nothing to say and there is no suppression to keep in place.
 *
 * Which is the half worth knowing: the class was covered by an
 * `eslint-disable-next-line`, and in the toolchain's copy of this pass the
 * formatter later wrapped the call, moved the regex to its own line, and left
 * the comment above the line it had been written over. A suppression a
 * formatter can detach from its target is one that stops working without
 * anybody editing it.
 */
const CONTROL = /\p{Cc}/gu;

/** The three a file is allowed to keep, because they are its own formatting. */
const FORMATTING = new Set(['\t', '\n', '\r']);

const escapeControls = {
	generateBundle(_options: unknown, bundle: Record<string, { code?: string; type: string }>) {
		for (const chunk of Object.values(bundle)) {
			if (chunk.type === 'chunk' && chunk.code) {
				chunk.code = chunk.code.replaceAll(CONTROL, (c) =>
					FORMATTING.has(c)
						? c
						: `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
				);
			}
		}
	},
	name: 'escape-control-characters',
};

const config: UserConfig = defineConfig({
	// Every entry here must have a matching subpath in the package's `exports`
	// map, and vice versa; `test/exports.test.ts` asserts they stay in sync.
	entry: {
		ansi: './src/ansi/index.ts',
		canvas: './src/canvas/index.ts',
		components: './src/components/index.ts',
		element: './src/element/index.ts',
		'error-handler': './src/error-handler.ts',
		help: './src/help/index.ts',
		input: './src/input/index.ts',
		'jsx-dev-runtime': './src/template/dev-runtime.ts',
		'jsx-runtime': './src/template/runtime.ts',
		layout: './src/layout/index.ts',
		index: './src/index.ts',
		paths: './src/paths.ts',
		renderer: './src/renderer/index.ts',
		routes: './src/parser/command/routes.ts',
		signals: './src/signals/index.ts',
		style: './src/style/index.ts',
		template: './src/template/index.ts',
		terminal: './src/terminal/index.ts',
		theme: './src/theme/index.ts',
		updates: './src/updates/index.ts',
		width: './src/width/index.ts',
		which: './src/which.ts',
		wrap: './src/wrap/index.ts',
	},
	format: ['es'],
	minify: true,
	platform: 'node',
	plugins: [escapeControls],
	tsconfig: './tsconfig.build.json',
	// `updates` spawns the worker by reading it off disk relative to its own
	// module URL, so it has to land next to dist/updates.mjs
	copy: [{ from: './src/updates/get-version-worker.js' }],
});

export default config;
