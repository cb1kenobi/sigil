import { captureComponents } from '../scripts/lib/component-capture.ts';
import { componentCapture } from '../src/lib/component-data.ts';
import { COMPONENTS } from '../src/lib/components.ts';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The components pages against the components they describe.
 *
 * Every capture in `src/transcripts/components/` is what an example drew and
 * what the built declarations say of its options, so this runs every example
 * again and reads the declarations again, and fails on any difference. That is
 * the only check that notices a component whose output changed, an option that
 * was added or reworded, or an example edited without capturing it again -- the
 * ways a page goes on looking right while describing something that is not
 * there any more.
 *
 * It needs `@ttylabs/sigil` built.
 */
describe('the components captures', () => {
  it('should be what the components draw now; if not, run `node scripts/capture-transcripts.ts`', async () => {
    const now = await captureComponents();

    for (const entry of COMPONENTS) {
      assert.deepEqual(
        now[entry.slug],
        componentCapture(entry.slug),
        `src/transcripts/components/${entry.slug}.json is out of date: run \`node scripts/capture-transcripts.ts\``
      );
    }
  });

  it('should hold a capture for every component and for nothing else', () => {
    const files = readdirSync(join(import.meta.dirname, '../src/transcripts/components'));

    assert.deepEqual(files.toSorted(), COMPONENTS.map((entry) => `${entry.slug}.json`).toSorted());
  });
});
