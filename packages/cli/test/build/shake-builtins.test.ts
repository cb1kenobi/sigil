import { bundleApp, discoverApp } from '../../src/build/index.ts';
import { tempDir } from '../temp.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  it('should leave the PNG codec and zlib out of an app that draws a spinner', async () => {
    const code = await built('shake-spinner');

    expect(code).toContain('working');
    expect(code).not.toContain('Not a PNG file');
    // a static import the reader below can see, so that its absences are about
    // these two builtins rather than about a spelling it stopped matching
    expect(code).toMatch(imports('node:fs'));
    for (const builtin of ['node:zlib', 'node:child_process']) {
      expect(code, builtin).not.toMatch(imports(builtin));
    }
  }, 60_000);

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
