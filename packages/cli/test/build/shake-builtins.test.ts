import { bundleApp, discoverApp } from '../../src/build/index.ts';
import { tempDir } from '../temp.js';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Builds a fixture and hands back every `.mjs` it wrote, joined.
 *
 * Every file rather than the entry's static graph, because what is asked is
 * whether the codec survived **anywhere** in what ships -- a lazy chunk holding
 * it would still be bytes on disk and a static import waiting to be reached.
 */
async function built(name: string): Promise<string> {
  const out = tempDir(`sigil-shake-${name}-`);
  await bundleApp({
    app: discoverApp(join(fixtures, name)),
    binName: name,
    out,
    tree: { commands: [], diagnostics: [] },
  });
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf-8'))
    .join('\n');
}

/** The editor's signal-name table, `Object.entries(os.constants.signals)` minified. */
const SIGNAL_TABLE = /Object\.entries\([\w$]+\.signals\)/;

/** A static import of `builtin`, in either spelling rolldown writes one. */
const imports = (builtin: string): RegExp => new RegExp(`\\b(?:from|import)\\s*["']${builtin}["']`);

// The question SIG-328 asked of `sigil build`: does bundling make the codec on
// the components entry moot? For the codec's **bytes**, yes -- rolldown drops it
// from an app that never decodes, which is why `Not a PNG file` is absent. For
// its **builtin**, it did not: the encoder's deflate options were an object at
// module level reading zlib's `constants`, a member read no tree-shaker can
// prove pure, so a one-spinner app kept `import{constants}from"node:zlib"` and
// a dangling `.Z_DEFAULT_STRATEGY`, and loaded zlib on every run. The editor's
// signal-name table was the same shape over `node:os`, and `child_process` came
// along as a bare `import"node:child_process"`. All three are inside functions
// now, and this is what says a built app stays clean of them
describe('what a built app keeps of a capability it never uses', () => {
  // the barrel, and the spinner's own subpath since SIG-330: the second is what
  // the README recommends, and resolving it is `sigil build` reading the
  // package's `exports` map one level deeper than any other subpath
  it.each(['shake-spinner', 'shake-spinner-subpath'])(
    'should leave the PNG codec and zlib out of an app that draws a spinner: %s',
    async (fixture) => {
      const code = await built(fixture);

      expect(code).toContain('working');
      expect(code).not.toContain('Not a PNG file');
      // a static import the reader below can see, so that its absences are about
      // these two builtins rather than about a spelling it stopped matching
      expect(code).toMatch(imports('node:fs'));
      for (const builtin of ['node:zlib', 'node:child_process']) {
        expect(code, builtin).not.toMatch(imports(builtin));
      }
      // the editor's signal-name table, which is the third: `node:os` cannot be
      // asked about by name, because the lazy chunks of the update check and the
      // completion installer import it for real, through `paths.ts`'s `homedir`,
      // so the loop itself is what is looked for
      expect(code).not.toMatch(SIGNAL_TABLE);
    },
    60_000
  );

  it('should still have the signal table in the package, so its absence means something', () => {
    // the presence half: the loop is in the package the app was built from, in
    // the spelling the absence above looks for. Somewhere in `dist/` rather than
    // in `components.mjs`, which since SIG-330 imports the editor from a chunk
    // of its own
    const dist = join(dirname(require.resolve('@ttylabs/sigil/package.json')), 'dist');
    const shipped = readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => readFileSync(join(dist, name), 'utf-8'))
      .join('\n');
    expect(shipped).toMatch(SIGNAL_TABLE);
  });

  it('should keep both in an app that draws a picture, so the absence means something', async () => {
    // the presence half: the decoder is in this one and reaches zlib the way the
    // source does. Not the encoder, which rolldown drops here too -- an app that
    // only draws a picture never writes one
    const code = await built('shake-image');

    expect(code).toContain('Not a PNG file');
    expect(code).toMatch(/getBuiltinModule\(\s*[`'"]node:zlib[`'"]\s*\)/);
    expect(code).not.toMatch(imports('node:zlib'));
  }, 60_000);
});
