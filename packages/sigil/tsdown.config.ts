import { readFileSync } from 'node:fs';
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

/**
 * The update worker, baked into `dist/updates.mjs` as a string.
 *
 * `src/updates/worker.ts` is piped into a runtime rather than imported on the
 * spawned path, and a file nothing imports is a file no bundler can see -- so
 * `workerSource()` read it off a path relative to its own module URL, which
 * points wherever the bundle was written. Every app `sigil build` produced
 * died on `ENOENT` the first time it checked for an update, with the build
 * reporting complete success, and the framework's own module was the one
 * reading a file it could not reach.
 *
 * So the read is replaced with the bytes. The module keeps its disk read from
 * source, which is what lets the worker stay an ordinary type-checked module
 * and what keeps both paths piping the same text; here there is nothing to
 * read from. `test/dist.test.ts` asserts the result, because a build that
 * quietly stops doing this looks exactly like one that does.
 */
const inlineWorker = {
  name: 'inline-update-worker',
  transform: {
    filter: { id: /src[/\\]updates[/\\]worker-source\.ts$/ },
    handler(code: string) {
      // the module is replaced whole, so an export added to it would work
      // from source and be gone once bundled -- which is the same shape as
      // the defect this plugin exists for. Refused here rather than left to
      // a comment, because it already happened once.
      const exports = code.match(/^export /gm) ?? [];
      if (exports.length !== 1) {
        throw new Error(
          `worker-source.ts must export workerSource() and nothing else; found ${exports.length} exports`
        );
      }

      const source = readFileSync(new URL('./src/updates/worker.ts', import.meta.url), 'utf-8');
      return {
        code: `export function workerSource() {\n  return ${JSON.stringify(source)};\n}\n`,
        map: null,
      };
    },
  },
};

const config: UserConfig = defineConfig({
  // Every entry here must have a matching subpath in the package's `exports`
  // map, and vice versa; `test/exports.test.ts` asserts they stay in sync.
  entry: {
    ansi: './src/ansi/index.ts',
    canvas: './src/canvas/index.ts',
    components: './src/components/index.ts',
    config: './src/config/index.ts',
    element: './src/element/index.ts',
    'error-handler': './src/error-handler.ts',
    help: './src/help/index.ts',
    i18n: './src/i18n/index.ts',
    'i18n-keys': './src/i18n/keys.ts',
    input: './src/input/index.ts',
    'jsx-dev-runtime': './src/template/dev-runtime.ts',
    'jsx-runtime': './src/template/runtime.ts',
    layout: './src/layout/index.ts',
    index: './src/index.ts',
    paths: './src/paths.ts',
    reference: './src/reference/index.ts',
    renderer: './src/renderer/index.ts',
    routes: './src/parser/command/routes.ts',
    signals: './src/signals/index.ts',
    style: './src/style/index.ts',
    template: './src/template/index.ts',
    testing: './src/testing/index.ts',
    terminal: './src/terminal/index.ts',
    theme: './src/theme/index.ts',
    themes: './src/theme/themes.ts',
    updates: './src/updates/index.ts',
    width: './src/width/index.ts',
    which: './src/which.ts',
    wrap: './src/wrap/index.ts',
  },
  format: ['es'],
  minify: true,
  platform: 'node',
  plugins: [inlineWorker, escapeControls],
  tsconfig: './tsconfig.build.json',
});

export default config;
